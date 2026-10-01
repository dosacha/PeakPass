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
const scenarioStart = new Trend('scenario_start_ms');
const arrivalLag = new Trend('arrival_lag_ms', true);
const scriptFailures = new Counter('script_failures');
const protocolFailures = new Counter('protocol_failures');

export const options = {
  // Exclude the right boundary: some k6 versions also schedule at exactly duration.
  scenarios: { buyers: { executor: 'constant-arrival-rate', rate: s.rate, timeUnit: '1s', duration: `${s.durationSeconds * 1000 - 1}ms`, preAllocatedVUs: s.preVus, maxVUs: s.maxVus, gracefulStop: `${s.drainSeconds}s` } },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
  systemTags: ['status', 'method', 'name', 'scenario', 'error_code', 'expected_response'],
  thresholds: {
    buyers_started: [`count==${s.users}`], iterations: [`count==${s.users}`], unexpected_failures: ['count==0'], replay_failures: ['count==0'], dropped_iterations: ['count==0'],
    'journey_duration{outcome:paid}': ['max>=0'],
    ...Object.fromEntries(['reservation', 'checkout', 'settlement'].map(stage => [`api_duration{stage:${stage},kind:normal}`, ['max>=0']])),
  },
};

function json(response) { try { return response.json(); } catch { return {}; } }
function request(stage, body, user, key, kind = 'normal', expectedOrderId, expectedTicketIds) {
  const payload = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  if (stage === 'settlement') {
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers['x-webhook-timestamp'] = timestamp;
    headers['x-webhook-signature'] = crypto.hmac('sha256', __ENV.FS_WEBHOOK_SECRET, `${timestamp}.${payload}`, 'hex');
  } else headers.Authorization = `Bearer ${user.token}`;
  const tags = { stage, kind, flow: user.flow, buyer: String(user.index), cohort: user.cohort, name: stage };
  const route = { reservation: '/reservations', checkout: '/checkouts', settlement: '/webhooks/payments/settlement' }[stage];
  const response = http.post(`${__ENV.FS_BASE_URL}${route}`, payload, { headers, tags, timeout: '10s' });
  const result = json(response);
  const valid = stage === 'settlement' ? response.status === 200 && paid(result, user, body.orderId, expectedTicketIds)
    : stage === 'reservation' ? response.status === 201 && !!result.id && result.status === 'active'
      && result.userId === user.id && result.eventId === fixture.eventId && result.quantity === s.quantity && result.tierId === fixture.tierId
    : response.status === 201 && !!result.order?.id && (!expectedOrderId || result.order.id === expectedOrderId) && result.order.userId === user.id && result.order.eventId === fixture.eventId
      && result.order.quantity === s.quantity && result.order.tierId === fixture.tierId
      && (result.order.reservationId ?? null) === (body.reservationId ?? null)
      && (kind === 'replay' ? result.order.status === 'paid' && ticketsMatch(result.tickets, user, result.order.id, expectedTicketIds)
        : result.order.status === 'pending' && Array.isArray(result.tickets) && result.tickets.length === 0);
  const metricTags = { ...tags, status: String(response.status), error_code: String(response.error_code || 0), code: result.error?.code ?? 'none', business: valid ? 'success' : 'failure' };
  responses.add(1, metricTags);
  apiDuration.add(response.timings.duration, metricTags);
  const expiredSettlement = stage === 'settlement' && kind !== 'replay' && response.status === 200 && result.paymentStatus === 'settled'
    && typeof result.duplicate === 'boolean'
    && result.order?.id === body.orderId && result.order.status === 'expired' && result.order.userId === user.id
    && result.order.eventId === fixture.eventId && result.order.quantity === s.quantity && Array.isArray(result.tickets) && result.tickets.length === 0;
  if (response.status >= 200 && response.status < 300 && !valid && !expiredSettlement) protocolFailures.add(1, metricTags);
  return { status: response.status, json: () => result, businessValid: valid };
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

function ticketsMatch(tickets, user, orderId, expectedIds) {
  return Array.isArray(tickets) && tickets.length === s.quantity
    && tickets.every(t => t && typeof t.id === 'string' && t.id.length > 0 && t.orderId === orderId
      && t.userId === user.id && t.eventId === fixture.eventId && t.status === 'active')
    && new Set(tickets.map(t => t.id)).size === s.quantity
    && (!expectedIds || tickets.every(t => expectedIds.includes(t.id)));
}

function paid(result, user, orderId, expectedTicketIds) {
  // Same-key HTTP replays can return the cached first response (duplicate: false).
  return typeof result.duplicate === 'boolean' && result.paymentStatus === 'settled' && result.order?.id === orderId && result.order.status === 'paid'
    && result.order.userId === user.id && result.order.eventId === fixture.eventId && result.order.quantity === s.quantity
    && ticketsMatch(result.tickets, user, orderId, expectedTicketIds);
}

export default function () {
  try { purchase(); } catch { unexpected.add(1); scriptFailures.add(1); }
}

function purchase() {
  const index = exec.scenario.iterationInTest;
  const user = { ...users[index], index, cohort: index < s.warmupSeconds * s.rate ? 'warmup' : 'measurement', flow: index % 2 === 0 ? 'reservation' : 'direct' };
  if (!user.id) throw new Error('Arrival model exceeded prepared users');
  const start = Date.now();
  const tags = { flow: user.flow, buyer: String(index), cohort: user.cohort };
  if (index === 0) scenarioStart.add(exec.scenario.startTime);
  arrivalLag.add(Math.max(0, start - exec.scenario.startTime - index * 1000 / s.rate), tags);
  started.add(1, tags);
  activeVUs.add(exec.instance.vusActive);
  unexpected.add(0); replayFailures.add(0);
  function finish(outcome) {
    outcomes.add(1, { ...tags, outcome });
    journeyDuration.add(Date.now() - start, { ...tags, outcome });
    if (outcome === 'paid') completed.add(1, tags);
    else if (outcome !== 'stock_rejected') unexpected.add(1);
  }
  function rejected(response) {
    const inventory = response.status === 409 && json(response).error?.code === 'INSUFFICIENT_INVENTORY';
    finish(s.stock === 'limited' && inventory ? 'stock_rejected' : response.status === 0 ? 'unknown_outcome' : `http_${response.status}`);
  }
  const body = { userId: user.id, eventId: fixture.eventId, tierId: fixture.tierId, quantity: s.quantity };
  if (user.flow === 'reservation') {
    const response = attempt('reservation', body, user);
    if (!response.businessValid) { rejected(response); return; }
    body.reservationId = json(response).id;
    sleep(s.thinkMs / 1000);
  }
  body.idempotencyKey = user.checkoutKey;
  const checkout = attempt('checkout', body, user, user.checkoutKey);
  const order = json(checkout).order;
  if (!checkout.businessValid) { rejected(checkout); return; }
  sleep(s.thinkMs / 1000);
  const settlement = { orderId: order.id, providerTransactionId: user.provider, status: 'settled' };
  const response = attempt('settlement', settlement, user, user.callbackKey);
  if (!response.businessValid) { rejected(response); return; }
  finish('paid');
  // Deliberate replays are outside purchase latency and never create another completion.
  if (s.replayEvery > 0 && index % s.replayEvery === 0) {
    const ticketIds = json(response).tickets.map(t => t.id);
    const replayCheckout = request('checkout', body, user, user.checkoutKey, 'replay', order.id, ticketIds);
    const replaySettlement = request('settlement', settlement, user, user.callbackKey, 'replay', order.id, ticketIds);
    if (!replayCheckout.businessValid || !replaySettlement.businessValid) replayFailures.add(1);
  }
}
