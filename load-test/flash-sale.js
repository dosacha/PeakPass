import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import crypto from 'k6/crypto';

const fixture = JSON.parse(__ENV.FS_MODEL);
const users = new SharedArray('private-users', () => JSON.parse(open(__ENV.FS_FIXTURE)).users);
const s = fixture.settings;
const started = new Counter('buyers_started');
const completed = new Counter('buyers_completed');
const outcomes = new Counter('journey_outcomes');
const unexpected = new Counter('unexpected_failures');
const replayFailures = new Counter('replay_failures');
const responses = new Counter('api_responses');
const apiDuration = new Trend('api_duration', true);
const journeyDuration = new Trend('journey_duration', true);
const activeVUs = new Trend('active_vus_at_arrival');

export const options = {
  // Exclude the right boundary: some k6 versions also schedule at exactly duration.
  scenarios: { buyers: { executor: 'constant-arrival-rate', rate: s.rate, timeUnit: '1s', duration: `${s.durationSeconds * 1000 - 1}ms`, preAllocatedVUs: s.preVus, maxVUs: s.maxVus, gracefulStop: '240s' } },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
  systemTags: ['status', 'method', 'name', 'scenario', 'error_code', 'expected_response'],
  thresholds: {
    buyers_started: [`count==${s.users}`], iterations: [`count==${s.users}`], unexpected_failures: ['count==0'], replay_failures: ['count==0'], dropped_iterations: ['count==0'],
    'journey_duration{outcome:paid}': ['max>=0'],
    ...Object.fromEntries(['reservation', 'checkout', 'settlement'].map(stage => [`api_duration{stage:${stage},kind:normal}`, ['max>=0']])),
  },
};

function json(response) { try { return response.json(); } catch { return {}; } }
function request(stage, body, user, key, kind = 'normal') {
  const payload = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  if (stage === 'settlement') {
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers['x-webhook-timestamp'] = timestamp;
    headers['x-webhook-signature'] = crypto.hmac('sha256', __ENV.FS_WEBHOOK_SECRET, `${timestamp}.${payload}`, 'hex');
  } else headers.Authorization = `Bearer ${user.token}`;
  const tags = { stage, kind, flow: user.flow, name: stage };
  const route = { reservation: '/reservations', checkout: '/checkouts', settlement: '/webhooks/payments/settlement' }[stage];
  const response = http.post(`${__ENV.FS_BASE_URL}${route}`, payload, { headers, tags, timeout: '10s' });
  responses.add(1, { ...tags, status: String(response.status), error_code: String(response.error_code || 0) });
  apiDuration.add(response.timings.duration, tags);
  return response;
}

function attempt(stage, body, user, key) {
  let response = request(stage, body, user, key);
  // Reservations have no idempotency contract: an unknown outcome must never be replayed.
  if (stage === 'reservation') return response;
  for (let retry = 0; retry < s.retries; retry++) {
    if (!(response.status === 0 || response.status >= 500 || json(response).error?.code === 'IDEMPOTENCY_IN_PROGRESS')) break;
    sleep(s.retryDelayMs / 1000);
    response = request(stage, body, user, key, 'retry');
  }
  return response;
}

function paid(result, user, orderId) {
  return result.paymentStatus === 'settled' && result.order?.id === orderId && result.order.status === 'paid'
    && result.order.userId === user.id && result.order.eventId === fixture.eventId && result.order.quantity === s.quantity
    && Array.isArray(result.tickets) && result.tickets.length === s.quantity
    && new Set(result.tickets.map(t => t.id)).size === s.quantity
    && result.tickets.every(t => t.orderId === orderId && t.userId === user.id && t.eventId === fixture.eventId && t.status === 'active');
}

export default function () {
  try { purchase(); } catch { unexpected.add(1); }
}

function purchase() {
  const index = exec.scenario.iterationInTest;
  const user = { ...users[index], flow: index % 2 === 0 ? 'reservation' : 'direct' };
  if (!user.id) throw new Error('Arrival model exceeded prepared users');
  const start = Date.now();
  started.add(1, { flow: user.flow });
  activeVUs.add(exec.instance.vusActive);
  unexpected.add(0); replayFailures.add(0);
  function finish(outcome) {
    outcomes.add(1, { outcome, flow: user.flow });
    journeyDuration.add(Date.now() - start, { outcome, flow: user.flow });
    if (outcome === 'paid') completed.add(1, { flow: user.flow });
    else if (outcome !== 'stock_rejected') unexpected.add(1);
  }
  function rejected(response) {
    const inventory = response.status === 409 && json(response).error?.code === 'INSUFFICIENT_INVENTORY';
    finish(s.stock === 'limited' && inventory ? 'stock_rejected' : response.status === 0 ? 'unknown_outcome' : `http_${response.status}`);
  }
  const body = { userId: user.id, eventId: fixture.eventId, tierId: fixture.tierId, quantity: s.quantity };
  if (user.flow === 'reservation') {
    const response = attempt('reservation', body, user);
    if (response.status !== 201 || !json(response).id) { rejected(response); return; }
    body.reservationId = json(response).id;
    sleep(s.thinkMs / 1000);
  }
  body.idempotencyKey = user.checkoutKey;
  const checkout = attempt('checkout', body, user, user.checkoutKey);
  const order = json(checkout).order;
  if (checkout.status !== 201 || !order?.id || order.userId !== user.id || order.eventId !== fixture.eventId || order.quantity !== s.quantity || order.status !== 'pending') { rejected(checkout); return; }
  sleep(s.thinkMs / 1000);
  const settlement = { orderId: order.id, providerTransactionId: user.provider, status: 'settled' };
  const response = attempt('settlement', settlement, user, user.callbackKey);
  if (response.status !== 200 || !paid(json(response), user, order.id)) { rejected(response); return; }
  finish('paid');
  // Deliberate replays are outside purchase latency and never create another completion.
  if (s.replayEvery > 0 && index % s.replayEvery === 0) {
    const replayCheckout = request('checkout', body, user, user.checkoutKey, 'replay');
    const replaySettlement = request('settlement', settlement, user, user.callbackKey, 'replay');
    if (replayCheckout.status !== 201 || json(replayCheckout).order?.id !== order.id || replaySettlement.status !== 200 || !paid(json(replaySettlement), user, order.id)) replayFailures.add(1);
  }
}
