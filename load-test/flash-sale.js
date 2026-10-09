import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import crypto from 'k6/crypto';
// The page's own polling code, unmodified. k6 loads it as CommonJS; the default export is its API.
import admission from '../frontend/admission-polling.js';

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
// flash-sale-v3.0: arm a is the journey below, unchanged; arms b and c take the queue journey at the end.
const queueArm = s.arm === 'b' || s.arm === 'c';
const admissionTrace = queueArm ? new Counter('admission_trace') : null;
const admissionJourney = queueArm ? new Counter('admission_journey') : null;

export const options = {
  // Exclude the right boundary: some k6 versions also schedule at exactly duration.
  scenarios: { buyers: { executor: 'constant-arrival-rate', rate: s.rate, timeUnit: '1s', duration: `${s.durationSeconds * 1000 - 1}ms`, preAllocatedVUs: s.preVus, maxVUs: s.maxVus, gracefulStop: `${s.drainSeconds}s`, ...(queueArm ? { exec: 'queued' } : {}) } },
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
  // Retries/replays may return either the first cached result or a DB replay.
  const duplicateValid = typeof result.duplicate === 'boolean' && (kind !== 'normal' || result.duplicate === false);
  const valid = stage === 'settlement' ? response.status === 200 && duplicateValid && paid(result, user, body.orderId, expectedTicketIds)
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
    && duplicateValid
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
  return result.paymentStatus === 'settled' && result.order?.id === orderId && result.order.status === 'paid'
    && result.order.userId === user.id && result.order.eventId === fixture.eventId && result.order.quantity === s.quantity && result.order.tierId === fixture.tierId
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
  function finish(outcome, result) {
    outcomes.add(1, { ...tags, outcome });
    journeyDuration.add(Date.now() - start, { ...tags, outcome });
    if (outcome === 'paid') completed.add(1, { ...tags, order_id: result.order.id, ticket_ids: JSON.stringify(result.tickets.map(t => t.id).sort()) });
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
  finish('paid', json(response));
  // Deliberate replays are outside purchase latency and never create another completion.
  if (s.replayEvery > 0 && index % s.replayEvery === 0) {
    const ticketIds = json(response).tickets.map(t => t.id);
    const replayCheckout = request('checkout', body, user, user.checkoutKey, 'replay', order.id, ticketIds);
    const replaySettlement = request('settlement', settlement, user, user.callbackKey, 'replay', order.id, ticketIds);
    if (!replayCheckout.businessValid || !replaySettlement.businessValid) replayFailures.add(1);
  }
}

// ---- Arms b and c: the queue journey (flash-sale-v3.0; v3.1 checks the times of a status answer and the cutoff before each replay; v3.2 and v3.3 the whole queue answer) ----
// One iteration is one buyer with one tab: one controller of frontend/admission-polling.js with its
// transport, clock, timers and visibility injected. k6 has no AbortController and cannot cancel a
// request, so a request ends by its timeout. Nothing here blocks the VU's event loop, and every timer
// is cleared when the journey ends: a pending timer would keep the iteration and its VU.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
class Abort { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } }

// request() without blocking: the same request, the same validation and the same metrics.
async function requestAsync(stage, body, user, key, kind = 'normal', expectedOrderId, expectedTicketIds, timeout = '10s') {
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
  const response = await http.asyncRequest('POST', `${__ENV.FS_BASE_URL}${route}`, payload, { headers, tags, timeout });
  const result = json(response);
  const duplicateValid = typeof result.duplicate === 'boolean' && (kind !== 'normal' || result.duplicate === false);
  const valid = stage === 'settlement' ? response.status === 200 && duplicateValid && paid(result, user, body.orderId, expectedTicketIds)
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
    && duplicateValid
    && result.order?.id === body.orderId && result.order.status === 'expired' && result.order.userId === user.id
    && result.order.eventId === fixture.eventId && result.order.quantity === s.quantity && Array.isArray(result.tickets) && result.tickets.length === 0;
  if (response.status >= 200 && response.status < 300 && !valid && !expiredSettlement) protocolFailures.add(1, metricTags);
  return { status: response.status, json: () => result, businessValid: valid, retryAfterMs: admission.parseRetryAfter(response.headers && response.headers['Retry-After']) };
}

// attempt() for checkout and settlement, with A's retry rule. Past the cutoff no repeat starts.
async function attemptAsync(stage, body, user, key, deadline) {
  let response = await requestAsync(stage, body, user, key);
  for (let retry = 0; retry < s.retries; retry++) {
    if (!(response.status === 0 || response.status >= 500 || response.json().error?.code === 'IDEMPOTENCY_IN_PROGRESS')) break;
    await pause(s.retryDelayMs);
    if (Date.now() >= deadline) break;
    response = await requestAsync(stage, body, user, key, 'retry');
  }
  return response;
}

// A status, join or cancel request of the controller. Recorded under its own stage, never as a purchase.
function admissionRequest(user, method, path, body, note) {
  const stage = method === 'GET' ? 'status' : method === 'POST' ? 'join' : 'cancel';
  const payload = body ? JSON.stringify(body) : null;
  const headers = { Authorization: `Bearer ${user.token}` };
  if (payload) headers['Content-Type'] = 'application/json';
  const tags = { stage, kind: 'normal', flow: user.flow, buyer: String(user.index), cohort: user.cohort, name: stage };
  note.requests[stage]++;
  return http.asyncRequest(method, `${__ENV.FS_BASE_URL}${path}`, payload, { headers, tags, timeout: admission.POLICY.timeoutMs }).then(response => {
    const result = json(response);
    // A success is the whole AdmissionResponse of admission-v1 (src/core/models/admission.ts), with the times the recognition
    // is computed from, and a join answers with an entry. Anything else is a protocol failure.
    const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
    const entry = result.admission;
    const snapshot = entry === null || (typeof entry === 'object' && typeof entry.admissionId === 'string' && entry.epoch === result.queue?.epoch
      && ['waiting', 'admitted', 'consumed', 'cancelled', 'expired'].includes(entry.state) && ['idle', 'processing', 'reconciling'].includes(entry.phase)
      && typeof entry.sequence === 'string' && (entry.position === null || typeof entry.position === 'number') && time(entry.joinedAt)
      && (entry.admittedAt === null || time(entry.admittedAt)) && (entry.expiresAt === null || time(entry.expiresAt))
      && (entry.state !== 'admitted' || (time(entry.admittedAt) && time(entry.expiresAt)))
      && (entry.reason === null || typeof entry.reason === 'string')
      && (entry.outcome === null || (typeof entry.outcome === 'object' && ['reservation', 'direct-checkout', 'rejected'].includes(entry.outcome.kind)
        && (entry.outcome.resourceId === null || typeof entry.outcome.resourceId === 'string') && (entry.outcome.code === null || typeof entry.outcome.code === 'string'))));
    const valid = (response.status === 200 || (response.status === 201 && stage === 'join')) && result.contractRevision === 'admission-v1' && time(result.serverTime)
      && result.queue?.eventId === fixture.eventId && typeof result.queue.epoch === 'string' && result.queue.mode === 'open'
      && (result.nextPollAfterMs === null || typeof result.nextPollAfterMs === 'number') && snapshot && (stage !== 'join' || entry !== null);
    const metricTags = { ...tags, status: String(response.status), error_code: String(response.error_code || 0), code: result.error?.code ?? 'none', business: valid ? 'success' : 'failure' };
    responses.add(1, metricTags);
    apiDuration.add(response.timings.duration, metricTags);
    if (response.status >= 200 && response.status < 300 && !valid) protocolFailures.add(1, metricTags);
    return { status: response.status, data: response.status === 0 ? null : result, retryAfterMs: admission.parseRetryAfter(response.headers && response.headers['Retry-After']) };
  });
}

// The outcome of a purchase answer that is not a success.
function refused(response) {
  const code = response.json().error?.code;
  if (response.status === 409 && code === 'INSUFFICIENT_INVENTORY' && s.stock === 'limited') return 'stock_rejected';
  if (response.status === 410) return { ADMISSION_EXPIRED: 'admission_expired', ADMISSION_CANCELLED: 'cancelled', ADMISSION_RESET: 'reset' }[code] ?? 'http_410';
  return response.status === 0 ? 'unknown_outcome' : `http_${response.status}`;
}

// The queue of one buyer: first status read, join once the epoch is known, polling in the arm's mode,
// then, a think time after recognition, the purchase that consumes the admission. The controller repeats
// that purchase with the same identity while it is undecided. Resolves with the purchase answer (`first`)
// or with the outcome the buyer is left with; rejects on a script error.
function queue(user, tags, deadline, note) {
  return new Promise((resolve, reject) => {
    const timers = new Set();
    let ended = false, buying = false, cutting = false, last = null, sent = null;
    const stop = () => { ended = true; for (const id of timers) clearTimeout(id); };
    const fail = error => { stop(); controller.dispose(); reject(error); };
    const guard = run => (...args) => { try { return run(...args); } catch (error) { fail(error); } };
    const later = (run, ms) => { const id = setTimeout(guard(() => { timers.delete(id); run(); }), ms); timers.add(id); };
    // An outcome ends the journey, so the controller stops at once. After a purchase answer it lives on
    // for its own read of the status, as on the page, unless the cutoff has passed.
    const end = value => {
      if (ended) return;
      stop();
      if (value.outcome || Date.now() >= deadline) controller.dispose();
      resolve({ controller, ...value });
    };
    const stranded = view => ({ waiting: 'queue_waiting', admitted: 'admitted_unpurchased', processing: 'admitted_unpurchased', expired: 'admission_expired',
      cancelled: 'cancelled', reset: 'reset', consumed: 'unknown_outcome' }[view.phase] ?? 'not_joined');
    // A purchase that was sent and is not decided: the controller's view of its last attempt.
    const undecided = () => (note.purchase ? (note.purchase.status === 0 ? 'unknown_outcome' : `http_${note.purchase.status}`) : null);
    const controller = admission.createController({
      apiBase: __ENV.FS_BASE_URL, userId: user.id, eventId: fixture.eventId, mode: s.pollMode, uuid: () => user.joinKey,
      visibility: { hidden: () => user.hidden, subscribe: () => () => {} },
      now: () => Date.now(), wall: () => Date.now(), setTimer: (run, ms) => setTimeout(run, ms), clearTimer: id => clearTimeout(id), AbortController: Abort,
      transport: ({ method, path, body }) => admissionRequest(user, method, path, body, note).catch(error => { fail(error); throw error; }),
      sendPurchase: body => requestAsync(user.flow === 'reservation' ? 'reservation' : 'checkout', body, user, body.idempotencyKey, note.purchases++ ? 'retry' : 'normal',
        undefined, undefined, admission.POLICY.purchaseTimeoutMs).then(response => {
        last = response;
        return { status: response.status, data: response.status === 0 ? null : response.json(), retryAfterMs: response.retryAfterMs };
      }, error => { fail(error); throw error; }),
      onTrace: guard(event => {
        note.events++;
        if (event.type === 'recognition') note.recognition = { lowerMs: event.lowerMs, upperMs: event.upperMs, layer: event.layer, at: event.tApply };
        if (event.type === 'recognition-missed') note.missed = event.state;
        if (event.type === 'purchase') note.purchase = { attempts: event.attempt, firstSendAt: note.purchase ? note.purchase.firstSendAt : event.tSend, lastRecvAt: event.tRecv, status: event.status, code: event.code };
        exec.vu.metrics.metadata.e = JSON.stringify(event);
        admissionTrace.add(1, { ...tags, type: event.type });
        delete exec.vu.metrics.metadata.e;
      }),
      onChange: guard(view => {
        if (ended) return;
        if (view.admission) note.entry = view.admission;
        // The cutoff passed while an attempt was out: its answer was undecided, and no repeat follows.
        if (cutting && view.purchase && view.purchase.status !== 'sending') { controller.stopPurchase(); return end({ outcome: undecided() ?? stranded(view) }); }
        if (view.purchase) { if (view.purchase.status === 'unconfirmed') end({ outcome: undecided() ?? 'unknown_outcome' }); return; }
        if (['expired', 'cancelled', 'reset', 'consumed'].includes(view.phase)) return end({ outcome: stranded(view) });
        if (view.phase === 'not-joined' && view.epoch && !view.busy) controller.join();
        if (view.phase === 'admitted' && !buying) {
          buying = true;
          const entry = view.admission;
          later(() => {
            sent = { userId: user.id, eventId: fixture.eventId, tierId: fixture.tierId, quantity: s.quantity };
            if (user.flow === 'direct') sent.idempotencyKey = user.checkoutKey;
            Object.assign(sent, { admissionId: entry.admissionId, admissionEpoch: entry.epoch });
            if (!controller.purchase(sent)) buying = false;
          }, s.thinkMs);
        }
      }),
      onPurchaseResult: guard(() => end({ first: last, sent })),
    });
    // The cutoff: nothing new starts. An attempt that is out may still be answered.
    later(() => {
      const view = controller.view();
      if (view.purchase && view.purchase.status === 'sending') cutting = true;
      else { controller.stopPurchase(); end({ outcome: undecided() ?? stranded(view) }); }
    }, Math.max(0, deadline - Date.now()));
    controller.start();
  });
}

// After the admission was consumed: checkout, settlement and replay with A's requests and retry rules.
async function settle(user, first, sent, deadline) {
  const late = () => Date.now() >= deadline;
  let body = sent, checkout = first;
  if (user.flow === 'reservation') {
    if (!first.businessValid) return { outcome: refused(first) };
    // The checkout of the reservation is the existing request, without admission fields.
    body = { userId: user.id, eventId: fixture.eventId, tierId: fixture.tierId, quantity: s.quantity, reservationId: first.json().id };
    await pause(s.thinkMs);
    if (late()) return { outcome: 'incomplete_checkout' };
    body.idempotencyKey = user.checkoutKey;
    checkout = await attemptAsync('checkout', body, user, user.checkoutKey, deadline);
  }
  const order = checkout.json().order;
  if (!checkout.businessValid) return { outcome: refused(checkout) };
  await pause(s.thinkMs);
  if (late()) return { outcome: 'incomplete_settlement' };
  const settlement = { orderId: order.id, providerTransactionId: user.provider, status: 'settled' };
  const response = await attemptAsync('settlement', settlement, user, user.callbackKey, deadline);
  if (!response.businessValid) return { outcome: refused(response) };
  return { outcome: 'paid', result: response.json(), replay: { body, settlement, orderId: order.id } };
}

export async function queued() {
  try { await purchaseThroughQueue(); } catch { unexpected.add(1); scriptFailures.add(1); }
}

async function purchaseThroughQueue() {
  const index = exec.scenario.iterationInTest;
  // Hidden tabs are assigned by index; 37 is coprime to 100 and keeps both flows in the share.
  const user = { ...users[index], index, cohort: index < s.warmupSeconds * s.rate ? 'warmup' : 'measurement', flow: index % 2 === 0 ? 'reservation' : 'direct',
    hidden: (index * 37) % 100 < s.hiddenShare };
  if (!user.id) throw new Error('Arrival model exceeded prepared users');
  const start = Date.now();
  const tags = { flow: user.flow, buyer: String(index), cohort: user.cohort };
  if (index === 0) scenarioStart.add(exec.scenario.startTime);
  arrivalLag.add(Math.max(0, start - exec.scenario.startTime - index * 1000 / s.rate), tags);
  started.add(1, tags);
  activeVUs.add(exec.instance.vusActive);
  unexpected.add(0); replayFailures.add(0);
  // One absolute instant for every buyer: scheduled end of arrivals plus the drain budget minus the margin.
  const deadline = exec.scenario.startTime + s.cutoffSeconds * 1000;
  const note = { events: 0, purchases: 0, requests: { status: 0, join: 0, cancel: 0 } };
  const waited = await queue(user, tags, deadline, note);
  let done;
  try { done = waited.first ? await settle(user, waited.first, waited.sent, deadline) : { outcome: waited.outcome }; }
  finally { waited.controller.dispose(); }
  const { outcome, result } = done, view = waited.controller.view(), entry = note.entry;
  // One summary of the buyer, after the controller's last trace event.
  exec.vu.metrics.metadata.e = JSON.stringify({ outcome, mode: s.pollMode, hidden: user.hidden, startedAt: start, endedAt: Date.now(), joinKey: user.joinKey,
    admissionId: entry ? entry.admissionId : null, epoch: entry ? entry.epoch : view.epoch, sequence: entry ? entry.sequence : null,
    joinedAt: entry ? entry.joinedAt : null, admittedAt: entry ? entry.admittedAt : null, phase: view.phase, polls: view.polls,
    requests: note.requests, purchaseAttempts: note.purchases, traceEvents: note.events,
    recognition: note.recognition ?? null, missed: note.missed ?? null, purchase: note.purchase ?? null });
  admissionJourney.add(1, { ...tags, outcome });
  delete exec.vu.metrics.metadata.e;
  outcomes.add(1, { ...tags, outcome });
  journeyDuration.add(Date.now() - start, { ...tags, outcome });
  if (outcome === 'paid') completed.add(1, { ...tags, order_id: result.order.id, ticket_ids: JSON.stringify(result.tickets.map(t => t.id).sort()) });
  else if (outcome !== 'stock_rejected') unexpected.add(1);
  // Deliberate replays are outside purchase latency and never create another completion.
  if (outcome === 'paid' && s.replayEvery > 0 && index % s.replayEvery === 0 && Date.now() < deadline) {
    const ticketIds = result.tickets.map(t => t.id), { body, settlement, orderId } = done.replay;
    const replayCheckout = await requestAsync('checkout', body, user, user.checkoutKey, 'replay', orderId, ticketIds);
    // The cutoff holds for each replay: the second does not start after it.
    const replaySettlement = Date.now() < deadline ? await requestAsync('settlement', settlement, user, user.callbackKey, 'replay', orderId, ticketIds) : null;
    if (!replayCheckout.businessValid || (replaySettlement && !replaySettlement.businessValid)) replayFailures.add(1);
  }
}
