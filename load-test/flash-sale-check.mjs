// Unit boundary checks; real HTTP/SQL evidence is produced by flash-sale-fixture.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext, runInContext, SourceTextModule, SyntheticModule } from 'node:vm';
import jwt from 'jsonwebtoken';
import { parseOptions, assertTarget, redact, summarizeRaw } from './flash-sale-fixture.mjs';
import * as harness from './flash-sale-fixture.mjs';

test('rejects ambiguous arrival models and unsafe run IDs before provisioning', () => {
  for (const args of [['--users', '0'], ['--rate', 'NaN'], ['--users', '11', '--rate', '2'],
    ['--run-id', '../shared'], ['--quantity', '101'], ['--pre-vus', '21', '--max-vus', '20'],
    ['--stock', 'shared'], ['--sample-ms', '0'], ['--retries', '-1'], ['--users', '2000', '--rate', '1000'],
    ['--users', '10010', '--rate', '1001'], ['--users', '2', '--rate', '2'],
    ['--sample-ms', '1000000']]) {
    assert.throws(() => parseOptions(args), args.join(' '));
  }
  assert.equal(parseOptions(['--users', '12', '--rate', '2']).durationSeconds, 6);
});

test('cleanup requires the owned database and marker, never merely a name prefix', () => {
  const owner = { project: 'peakpass-fs-check', database: 'fs_check', marker: 'unique-secret-marker' };
  const target = { host: '127.0.0.1', database: 'fs_check', project: owner.project, marker: owner.marker };
  assert.doesNotThrow(() => assertTarget(owner, target));
  for (const change of [{ host: 'production' }, { database: 'peakpass' }, { project: 'peakpass-fs-other' }, { marker: null }]) {
    assert.throws(() => assertTarget(owner, { ...target, ...change }));
  }
});

test('evidence redaction removes exact secrets and signed JWTs', () => {
  const token = jwt.sign({ sub: 'synthetic-user' }, 'a'.repeat(32));
  const output = redact(`secret=raw-secret token=${token}`, ['raw-secret']);
  assert.ok(!output.includes('raw-secret'));
  assert.ok(!output.includes(token));
});

const controllerSource = readFile(new URL('../frontend/admission-polling.js', import.meta.url), 'utf8');
// Links flash-sale.js in a context. The page's controller is the real file, evaluated in that context.
async function loadScript(context, boundaries) {
  runInContext(await controllerSource, context, { filename: 'frontend/admission-polling.js' });
  const modules = { ...boundaries, '../frontend/admission-polling.js': { default: context.PeakPassAdmission } };
  const script = new SourceTextModule(await readFile(new URL('./flash-sale.js', import.meta.url), 'utf8'), { context });
  await script.link(name => new SyntheticModule(Object.keys(modules[name]), function () {
    for (const [key, value] of Object.entries(modules[name])) this.setExport(key, value);
  }, { context }));
  await script.evaluate();
  return script;
}

async function runScenario(fault = null, iteration = 0) {
  const secret = 'test-webhook-secret';
  const settings = parseOptions(['--users', '2', '--rate', '1', '--think-ms', '0', '--replay-every', '1']);
  const users = [0, 1].map(i => ({ id: `user-${i}`, token: jwt.sign({ sub: `user-${i}` }, 'a'.repeat(32)), checkoutKey: `checkout-${i}`, callbackKey: `callback-${i}`, provider: `provider-${i}` }));
  const fixture = { settings, eventId: 'event', tierId: 'standard', users };
  const requests = [], metrics = [];
  const context = createContext({ __ENV: { FS_FIXTURE: 'fixture', FS_BASE_URL: 'http://local', FS_WEBHOOK_SECRET: secret, FS_MODEL: JSON.stringify({ settings, eventId: 'event', tierId: 'standard' }) }, open: () => JSON.stringify(fixture), Date, Math, JSON });
  const faults = [fault].flat().filter(Boolean), usedFaults = new Set();
  const http = { post(url, body, options) {
    const input = JSON.parse(body), stage = options.tags.stage;
    requests.push({ url, body, input, options, stage });
    if (stage !== 'settlement') assert.equal(jwt.decode(options.headers.Authorization.slice(7)).sub, input.userId);
    else {
      assert.equal(options.headers.Authorization, undefined, 'provider uses HMAC, not a buyer JWT');
      assert.equal(options.headers['x-webhook-signature'], createHmac('sha256', secret).update(`${options.headers['x-webhook-timestamp']}.${body}`).digest('hex'));
    }
    const injected = faults.find(f => stage === f.stage && (!f.kind || f.kind === options.tags.kind) && (!f.once || !usedFaults.has(f)));
    if (injected) {
      usedFaults.add(injected);
      return Object.freeze({ status: injected.status, error_code: injected.status === 0 ? 1050 : 0, timings: { duration: 1 }, json: () => injected.body ?? { error: { code: injected.code ?? 'INTERNAL_ERROR' } } });
    }
    const user = users[iteration];
    const order = { id: 'order', status: 'paid', userId: user.id, eventId: 'event', quantity: settings.quantity, tierId: 'standard', reservationId: iteration === 0 ? 'reservation' : null };
    const tickets = Array.from({ length: settings.quantity }, (_, i) => ({ id: `ticket-${i}`, orderId: 'order', userId: user.id, eventId: 'event', status: 'active' }));
    const result = stage === 'reservation' ? { id: 'reservation', userId: user.id, eventId: 'event', quantity: settings.quantity, tierId: 'standard', status: 'active' } : stage === 'checkout' ? (options.tags.kind === 'replay' ? { order, tickets } : { order: { ...order, status: 'pending' }, tickets: [] }) : {
      order, paymentStatus: 'settled', tickets, duplicate: false,
    };
    return Object.freeze({ status: stage === 'settlement' ? 200 : 201, timings: { duration: 1 }, json: () => result });
  } };
  class Metric { constructor(name) { this.name = name; } add(value, tags) { metrics.push({ name: this.name, value, tags }); } }
  const boundaries = {
    'k6/http': { default: http }, k6: { sleep() {} },
    'k6/metrics': { Counter: Metric, Trend: Metric },
    'k6/execution': { default: { scenario: { iterationInTest: iteration, startTime: Date.now() }, instance: { vusActive: 1 } } },
    'k6/data': { SharedArray: class { constructor(_name, factory) { return factory(); } } },
    'k6/crypto': { default: { hmac: (_algorithm, key, value) => createHmac('sha256', key).update(value).digest('hex') } },
  };
  const script = await loadScript(context, boundaries);
  script.namespace.default();
  return { requests, metrics };
}

test('both purchase paths sign requests and replay without counting extra buyers', async () => {
  for (const iteration of [0, 1]) {
    const { requests, metrics } = await runScenario(null, iteration);
    assert.equal(requests.filter(r => r.stage === 'reservation').length, iteration === 0 ? 1 : 0);
    for (const stage of ['checkout', 'settlement']) {
      const calls = requests.filter(r => r.stage === stage);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].body, calls[1].body);
      assert.equal(calls[0].options.headers['Idempotency-Key'], calls[1].options.headers['Idempotency-Key']);
      assert.equal(calls[1].options.tags.kind, 'replay');
    }
    assert.equal(metrics.filter(m => m.name === 'buyers_completed').length, 1);
    const completion = metrics.find(m => m.name === 'buyers_completed');
    assert.equal(completion.tags.order_id, 'order');
    assert.deepEqual(JSON.parse(completion.tags.ticket_ids), ['ticket-0', 'ticket-1']);
  }
});

test('malformed 201 bodies fail protocol validation and success latency excludes them', async () => {
  for (const stage of ['reservation', 'checkout']) {
    const { metrics } = await runScenario({ stage, status: 201, body: { id: 'wrong-reservation', order: { id: 'wrong-order' } } });
    assert.equal(metrics.filter(m => m.name === 'buyers_completed').length, 0);
    assert.ok(metrics.some(m => m.name === 'protocol_failures' && m.value === 1));
    assert.ok(metrics.some(m => m.name === 'api_duration' && m.tags.stage === stage && m.tags.business === 'failure'));
  }
});

test('a successful replay must return the original checkout identity', async () => {
  const { metrics } = await runScenario({ stage: 'checkout', kind: 'replay', status: 201,
    body: { order: { id: 'different-order', status: 'paid', userId: 'user-0', eventId: 'event', quantity: 2, tierId: 'standard', reservationId: 'reservation' } } });
  assert.ok(metrics.some(m => m.name === 'protocol_failures' && m.value === 1));
  assert.ok(metrics.some(m => m.name === 'api_duration' && m.tags.kind === 'replay' && m.tags.stage === 'checkout' && m.tags.business === 'failure'));
});

test('checkout requires empty pending tickets and the original paid replay ticket set', async () => {
  const order = { id: 'order', status: 'pending', userId: 'user-0', eventId: 'event', quantity: 2, tierId: 'standard', reservationId: 'reservation' };
  const tickets = [0, 1].map(i => ({ id: `ticket-${i}`, orderId: 'order', userId: 'user-0', eventId: 'event', status: 'active' }));
  for (const body of [{ order }, { order, tickets: null }, { order, tickets }]) {
    const { metrics } = await runScenario({ stage: 'checkout', status: 201, body });
    assert.ok(metrics.some(m => m.name === 'protocol_failures' && m.value === 1));
    assert.equal(metrics.filter(m => m.name === 'buyers_completed').length, 0);
  }
  const paidOrder = { ...order, status: 'paid' };
  for (const body of [{ order, tickets: [] }, { order: paidOrder }, ...[[], [tickets[0], tickets[0]], [null, tickets[1]],
    tickets.map(t => ({ ...t, id: '' })), tickets.map(t => ({ ...t, id: `other-${t.id}` })),
    tickets.map(t => ({ ...t, userId: 'other' })), tickets.map(t => ({ ...t, status: 'used' }))].map(t => ({ order: paidOrder, tickets: t }))]) {
    const { metrics } = await runScenario({ stage: 'checkout', kind: 'replay', status: 201, body });
    assert.ok(metrics.some(m => m.name === 'protocol_failures' && m.value === 1));
    assert.ok(metrics.some(m => m.name === 'replay_failures' && m.value === 1));
    assert.equal(metrics.filter(m => m.name === 'buyers_completed').length, 1);
  }
  const { metrics } = await runScenario({ stage: 'checkout', kind: 'replay', status: 201, body: { order: paidOrder, tickets: [...tickets].reverse() } });
  assert.ok(!metrics.some(m => ['protocol_failures', 'replay_failures'].includes(m.name) && m.value === 1));
});

test('window options bound warmup, drain and observer gaps before provisioning', () => {
  const s = parseOptions(['--users', '80', '--rate', '2', '--warmup-seconds', '10', '--drain-seconds', '30', '--limiter-max', '1000000']);
  assert.equal(s.measurementSeconds, 30);
  for (const extra of [['--warmup-seconds', '39'], ['--drain-seconds', '0'], ['--sample-ms', '1001']]) {
    assert.throws(() => parseOptions(['--users', '80', '--rate', '2', ...extra]));
  }
});

test('settlement replay cannot replace confirmed paid tickets with expiry or another set', async () => {
  const order = { id: 'order', status: 'paid', userId: 'user-0', eventId: 'event', quantity: 2, tierId: 'standard' };
  const tickets = [0, 1].map(i => ({ id: `other-${i}`, orderId: 'order', userId: 'user-0', eventId: 'event', status: 'active' }));
  for (const body of [{ paymentStatus: 'settled', duplicate: true, order: { ...order, status: 'expired' }, tickets: [] }, { paymentStatus: 'settled', duplicate: true, order, tickets }]) {
    const { metrics } = await runScenario({ stage: 'settlement', kind: 'replay', status: 200, body });
    assert.ok(metrics.some(m => m.name === 'protocol_failures' && m.value === 1));
    assert.ok(metrics.some(m => m.name === 'replay_failures' && m.value === 1));
    assert.equal(metrics.filter(m => m.name === 'buyers_completed').length, 1);
  }
});

test('settlement duplicate marker is boolean, including cached false and uncached true replays', async () => {
  const order = { id: 'order', status: 'paid', userId: 'user-0', eventId: 'event', quantity: 2, tierId: 'standard' };
  const tickets = [0, 1].map(i => ({ id: `ticket-${i}`, orderId: 'order', userId: 'user-0', eventId: 'event', status: 'active' }));
  for (const kind of ['normal', 'retry', 'replay']) {
    for (const duplicate of [undefined, null, 'true', 'false', 0, false, true]) {
      const body = { order, tickets, paymentStatus: 'settled', ...(duplicate === undefined ? {} : { duplicate }) };
      const faults = [{ stage: 'settlement', kind, status: 200, body }];
      if (kind === 'retry') faults.unshift({ stage: 'settlement', kind: 'normal', status: 503, once: true });
      const { metrics, requests } = await runScenario(faults);
      const valid = kind === 'normal' ? duplicate === false : typeof duplicate === 'boolean';
      assert.ok(requests.some(r => r.stage === 'settlement' && r.options.tags.kind === kind));
      assert.equal(metrics.some(m => m.name === 'protocol_failures' && m.value === 1), !valid);
      assert.equal(metrics.some(m => m.name === 'api_duration' && m.tags.stage === 'settlement' && m.tags.kind === kind && m.tags.business === 'success'), valid);
      assert.equal(metrics.filter(m => m.name === 'buyers_completed').length, valid || kind === 'replay' ? 1 : 0);
      assert.equal(metrics.some(m => m.name === 'replay_failures' && m.value === 1), !valid && kind === 'replay');
    }
  }
});

test('paid settlement responses retain the fixture tier on normal, retry and replay', async () => {
  for (const kind of ['normal', 'retry', 'replay']) {
    for (const tierId of [undefined, null, 'other', 'standard']) {
      const body = { paymentStatus: 'settled', duplicate: false,
        order: { id: 'order', status: 'paid', userId: 'user-0', eventId: 'event', quantity: 2, tierId },
        tickets: [0, 1].map(i => ({ id: `ticket-${i}`, orderId: 'order', userId: 'user-0', eventId: 'event', status: 'active' })) };
      const faults = [{ stage: 'settlement', kind, status: 200, body }];
      if (kind === 'retry') faults.unshift({ stage: 'settlement', kind: 'normal', status: 503, once: true });
      const { metrics } = await runScenario(faults);
      assert.equal(metrics.some(m => m.name === 'protocol_failures'), tierId !== 'standard');
      assert.equal(metrics.filter(m => m.name === 'buyers_completed').length, tierId === 'standard' || kind === 'replay' ? 1 : 0);
      assert.equal(metrics.some(m => m.name === 'replay_failures' && m.value === 1), tierId !== 'standard' && kind === 'replay');
    }
  }
});

test('pending orders and expired settled reconciliation are not paid or corrupt', () => {
  assert.equal(typeof harness.verifySnapshot, 'function');
  const users = [{ id: 'u', checkoutKey: 'ck', callbackKey: 'cb', provider: 'provider' }];
  const settings = parseOptions(['--users', '2', '--rate', '1']);
  const data = { events: [{ id: 'e', available_seats: 2, total_seats: 4 }], reservations: [],
    orders: [{ id: 'o', user_id: 'u', event_id: 'e', quantity: 2, status: 'pending', idempotency_key: 'ck' }], tickets: [],
    payments: [{ order_id: 'o', status: 'pending', provider_transaction_id: null, idempotency_key: 'ck' }], callbackKeys: [] };
  let v = harness.verifySnapshot(data, users, settings, {}, 99);
  assert.equal(v.counts.paidOrders, 0); assert.equal(v.counts.ordersByStatus.pending, 1);
  assert.equal(v.integrityPassed, true); assert.equal(v.passed, false);
  data.orders[0].status = 'expired'; data.events[0].available_seats = 4;
  data.payments.push({ order_id: 'o', status: 'settled', provider_transaction_id: 'provider', idempotency_key: 'cb', reconciliation_required: true });
  data.callbackKeys.push({ order_id: 'o', provider_transaction_id: 'provider', idempotency_key: 'cb', callback_status: 'settled' });
  v = harness.verifySnapshot(data, users, settings, {}, 99);
  assert.equal(v.integrityPassed, true); assert.equal(v.counts.paidOrders, 0);
  for (const reconciliation_required of [false, null, undefined]) {
    const payments = [data.payments[0], { ...data.payments[1], reconciliation_required }];
    assert.equal(harness.verifySnapshot({ ...data, payments }, users, settings, {}, 99).integrityPassed, false);
  }
  data.callbackKeys[0].provider_transaction_id = 'other';
  assert.equal(harness.verifySnapshot(data, users, settings, {}, 99).integrityPassed, false);
});

test('canonical source identity ignores CRLF while artifact identity does not', () => {
  assert.equal(typeof harness.sourceHash, 'function');
  assert.equal(harness.sourceHash('one\r\ntwo\r\n'), harness.sourceHash('one\ntwo\n'));
  assert.notEqual(harness.sourceHash('one\ntwo\n'), harness.sourceHash('one\nchanged\n'));
});

test('every order retains exactly one pending checkout audit with the buyer key', () => {
  const users = [{ id: 'u', checkoutKey: 'ck', callbackKey: 'cb', provider: 'provider' }];
  const settings = parseOptions(['--users', '2', '--rate', '1']);
  const pending = { order_id: 'o', status: 'pending', provider_transaction_id: null, idempotency_key: 'ck' };
  for (const status of ['pending', 'paid', 'expired']) {
    const data = { events: [{ id: 'e', available_seats: status === 'expired' ? 4 : 2, total_seats: 4 }], reservations: [],
      orders: [{ id: 'o', user_id: 'u', event_id: 'e', quantity: 2, status, idempotency_key: 'ck' }],
      tickets: status === 'paid' ? [0, 1].map(i => ({ id: `t${i}`, order_id: 'o', user_id: 'u', event_id: 'e', status: 'active' })) : [],
      payments: [pending], callbackKeys: [] };
    if (status === 'paid') {
      data.payments.push({ order_id: 'o', status: 'settled', provider_transaction_id: 'provider', idempotency_key: 'cb', reconciliation_required: false });
      data.callbackKeys.push({ order_id: 'o', provider_transaction_id: 'provider', idempotency_key: 'cb', callback_status: 'settled' });
    }
    assert.equal(harness.verifySnapshot(data, users, settings, {}, 99).integrityPassed, true);
    if (status === 'paid') {
      for (const reconciliation_required of [true, null, undefined]) {
        const payments = [pending, { ...data.payments[1], reconciliation_required }];
        assert.equal(harness.verifySnapshot({ ...data, payments }, users, settings, {}, 99).integrityPassed, false);
      }
    }
    const terminal = data.payments.filter(p => p !== pending);
    for (const facts of [[], [pending, pending], [{ ...pending, status: 'settled' }], [{ ...pending, idempotency_key: 'wrong' }],
      [pending, { ...pending, order_id: 'unknown' }]]) {
      assert.equal(harness.verifySnapshot({ ...data, payments: [...terminal, ...facts] }, users, settings, {}, 99).integrityPassed, false, status);
    }
  }
});

test('measurement window includes its left boundary only and keeps warmup spillover separate', async () => {
  const { analyzePoints } = await import('./flash-sale-analysis.mjs');
  const start = Date.parse('2026-10-01T00:00:00Z');
  const point = (metric, seconds, tags = {}, value = 1) => ({ metric, data: { time: new Date(start + seconds * 1000).toISOString(), value, tags } });
  const points = [point('scenario_start_ms', 0, {}, start), point('buyers_started', 0, { buyer: '0', cohort: 'warmup' }),
    point('buyers_started', 10, { buyer: '10', cohort: 'measurement' }), point('buyers_started', 39, { buyer: '39', cohort: 'measurement' }),
    point('buyers_completed', 10, { buyer: '0', cohort: 'warmup', order_id: 'o0', ticket_ids: '["t0"]' }), point('buyers_completed', 39.999, { buyer: '10', cohort: 'measurement', order_id: 'o10', ticket_ids: '["t10"]' }),
    point('buyers_completed', 40, { buyer: '39', cohort: 'measurement', order_id: 'o39', ticket_ids: '["t39"]' })];
  const manifest = { settings: { users: 40, rate: 1, warmupSeconds: 10, durationSeconds: 40, measurementSeconds: 30, drainSeconds: 30 },
    fixture: { userIds: Array.from({ length: 40 }, (_, i) => `u${i}`) } };
  const result = analyzePoints(points, manifest, { orders: [0, 10, 39].map(i => ({ id: `o${i}`, user_id: `u${i}`, status: 'paid' })), tickets: [0, 10, 39].map(i => ({ id: `t${i}`, order_id: `o${i}` })) });
  assert.equal(result.window.confirmedPaid, 2); assert.equal(result.window.warmupSpillover, 1);
  assert.equal(result.window.paidPerSecond, 2 / 30); assert.equal(result.cohort.confirmedPaid, 2);
  assert.equal(result.cohort.offered, 30); assert.equal(result.cohort.actualWindowArrivals, 2);
});

test('confirmed paid requires the captured order and exact SQL ticket identity', async () => {
  const { analyzePoints } = await import('./flash-sale-analysis.mjs');
  const start = Date.parse('2026-10-01T00:00:00Z');
  const manifest = { settings: { users: 2, rate: 1, warmupSeconds: 0, durationSeconds: 2, measurementSeconds: 2, drainSeconds: 30 }, fixture: { userIds: ['u0', 'u1'] } };
  const sql = { orders: [{ id: 'o0', user_id: 'u0', status: 'paid' }], tickets: [{ id: 't1', order_id: 'o0' }, { id: 't0', order_id: 'o0' }] };
  const analyze = tags => analyzePoints([
    { metric: 'scenario_start_ms', data: { value: start } },
    { metric: 'buyers_completed', data: { time: new Date(start + 1000).toISOString(), value: 1, tags: { buyer: '0', ...tags } } },
  ], manifest, sql);
  const valid = { order_id: 'o0', ticket_ids: '["t0","t1"]' };
  assert.equal(analyze(valid).window.confirmedPaid, 1, 'SQL ordering is irrelevant');
  assert.equal(analyze({ ...valid, ticket_ids: '["t1","t0"]' }).window.confirmedPaid, 1, 'HTTP ordering is irrelevant');
  for (const tags of [{ ...valid, ticket_ids: '["fake0","fake1"]' }, { ...valid, ticket_ids: '["t0"]' }, { ...valid, order_id: 'other' }]) {
    const a = analyze(tags);
    assert.equal(a.window.confirmedPaid, 0);
    assert.equal(a.all.httpPaidIdentityMismatches, 1);
    assert.equal(a.all.missingPaidIdentity, 0);
  }
  for (const tags of [{}, { order_id: 'o0' }, { ...valid, ticket_ids: 'bad-json' }, { ...valid, ticket_ids: '["t0","t0"]' }]) {
    const a = analyze(tags);
    assert.equal(a.window.confirmedPaid, 0);
    assert.equal(a.all.missingPaidIdentity, 1);
    assert.equal(a.all.httpPaidIdentityMismatches, 0);
  }
});

test('coverage detects missing boundaries and errors even for failed smoke', async () => {
  const { coverage, classify } = await import('./flash-sale-analysis.mjs');
  assert.equal(coverage([{ at: 0 }, { at: 500 }, { at: 1000 }], 0, 1000, 500).complete, true);
  assert.equal(coverage([{ at: 0 }, { at: 2000 }], 0, 2000, 500).complete, false);
  assert.equal(coverage([{ at: 500 }, { at: 1000, error: 'lost sample' }], 0, 1000, 500).complete, false);
  assert.equal(coverage([], 0, 1000, 500).complete, false);
  const state = { integrity: true, valid: true, stable: false, stock: 'ample', smokePassed: false, k6ExitCode: 99 };
  assert.equal(classify(state), 'valid-overload');
  assert.equal(classify({ ...state, valid: false }), 'invalid-measurement');
  assert.equal(classify({ ...state, integrity: false }), 'integrity-defect');
});

test('offline reanalysis rejects altered archived evidence', async () => {
  const { verifyArtifacts } = await import('./flash-sale-analysis.mjs');
  assert.equal(typeof verifyArtifacts, 'function');
  const directory = await mkdtemp(join(tmpdir(), 'peakpass-hash-check-'));
  try {
    await writeFile(join(directory, 'raw.json'), 'original');
    const { createHash } = await import('node:crypto');
    const manifest = { artifactHashes: { 'raw.json': createHash('sha256').update('original').digest('hex') } };
    await verifyArtifacts(directory, manifest);
    await writeFile(join(directory, 'raw.json'), 'changed');
    await assert.rejects(verifyArtifacts(directory, manifest), /hash/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('raw accounting requires paired attempt latency and terminal journey evidence', async () => {
  const { metricAccounting } = await import('./flash-sale-analysis.mjs');
  assert.equal(typeof metricAccounting, 'function');
  const p = (metric, tags = {}) => ({ metric, data: { value: 1, tags } });
  const raw = [p('buyers_started', { buyer: '0' }), p('buyers_completed', { buyer: '0' }), p('journey_outcomes', { buyer: '0', outcome: 'paid' }),
    p('journey_duration', { buyer: '0', outcome: 'paid' }), p('api_responses', { buyer: '0', stage: 'checkout' }), p('api_duration', { buyer: '0', stage: 'checkout' }), p('active_vus_at_arrival'), p('arrival_lag_ms')];
  const summary = { buyers_started: { count: 1 }, buyers_completed: { count: 1 }, iterations: { count: 1 }, http_reqs: { count: 1 } };
  assert.equal(metricAccounting(raw, summary, 1).complete, true);
  for (const missing of ['api_duration', 'journey_outcomes', 'journey_duration', 'active_vus_at_arrival', 'arrival_lag_ms']) {
    assert.equal(metricAccounting(raw.filter(p => p.metric !== missing), summary, 1).complete, false, missing);
  }
  assert.equal(metricAccounting(raw.filter(p => !p.metric.startsWith('api_')), summary, 1).complete, false);
});

test('raw accounting rejects interrupted buyers before finish and during replay', async () => {
  const { metricAccounting } = await import('./flash-sale-analysis.mjs');
  const p = (metric, buyer, outcome) => ({ metric, data: { value: 1, tags: { buyer: String(buyer), ...(outcome ? { outcome } : {}) } } });
  const raw = [];
  for (let i = 0; i < 100; i++) {
    raw.push(p('buyers_started', i), p('active_vus_at_arrival', i), p('arrival_lag_ms', i));
    if (i < 99) raw.push(p('buyers_completed', i), p('journey_outcomes', i, 'paid'), p('journey_duration', i, 'paid'));
  }
  const summary = { buyers_started: { count: 100 }, buyers_completed: { count: 99 }, iterations: { count: 99 } };
  assert.equal(metricAccounting(raw, summary, 100).complete, false, '99% paid must not hide one interrupted buyer');
  raw.push(p('journey_outcomes', 99, 'http_500'), p('journey_duration', 99, 'http_500'));
  assert.equal(metricAccounting(raw, { ...summary, iterations: { count: 100 } }, 100).complete, true, 'fully observed failure is valid accounting');
  assert.equal(metricAccounting(raw, summary, 100).complete, false, 'post-finish replay interruption is invalid');
  const duplicate = raw.map(point => point.metric.startsWith('journey_') && point.data.tags.buyer === '99' ? { ...point, data: { ...point.data, tags: { ...point.data.tags, buyer: '98' } } } : point);
  assert.equal(metricAccounting(duplicate, { ...summary, iterations: { count: 100 } }, 100).complete, false, 'duplicate terminal cannot replace a missing buyer');
});

test('generator evidence identifies the engine even when low-load CPU counters stay constant', async () => {
  const { generatorObserved } = await import('./flash-sale-analysis.mjs');
  assert.equal(typeof generatorObserved, 'function');
  const sample = (isShim, at) => ({ at, generator: { cpuSeconds: .0625, processes: [{ path: 'k6.exe', isShim, cpuSeconds: .0625, memoryBytes: 60000000 }] } });
  assert.equal(generatorObserved([sample(true,0), sample(true,3000)],0,3000), false);
  assert.equal(generatorObserved([sample(false,0), sample(false,3000)],0,3000), true);
  assert.equal(generatorObserved([{ at:0,generator: null }, { at:3000,generator: { cpuSeconds: 1 } }],0,3000), false);
});

test('generator coverage tolerates process exit across the end boundary but rejects interior gaps', async () => {
  const { generatorObserved } = await import('./flash-sale-analysis.mjs');
  const sample = at => ({ at, generator: { cpuSeconds: 1, processes: [{ path: 'k6.exe', isShim: false, cpuSeconds: 1, memoryBytes: 60000000 }] } });
  const samples = [0,3000,6000,9000].map(sample);
  assert.equal(generatorObserved([...samples,{at:9999,endedAt:11000,generator:null}],0,10000,10100),true);
  assert.equal(generatorObserved([...samples,{at:5999,endedAt:6500,generator:null}],0,10000,10100),false);
  assert.equal(generatorObserved([sample(0),sample(9000)],0,10000),false);
});

test('reservation timeout is never replayed; transient checkout retry preserves the logical request', async () => {
  const reservation = await runScenario({ stage: 'reservation', status: 0 });
  assert.equal(reservation.requests.length, 1);
  assert.equal(reservation.metrics.filter(m => m.name === 'buyers_completed').length, 0);
  const checkout = await runScenario({ stage: 'checkout', status: 503, once: true });
  const attempts = checkout.requests.filter(r => r.stage === 'checkout');
  assert.equal(attempts[0].body, attempts[1].body);
  assert.equal(attempts[0].options.headers['Idempotency-Key'], attempts[1].options.headers['Idempotency-Key']);
  assert.equal(attempts[1].options.tags.kind, 'retry');
  assert.equal(checkout.metrics.filter(m => m.name === 'buyers_completed').length, 1);
});

test('errors and settled-but-expired responses cannot count as a successful purchase', async () => {
  for (const status of [0, 401, 403, 409, 429, 500]) {
    const { metrics } = await runScenario({ stage: 'settlement', status });
    assert.equal(metrics.filter(m => m.name === 'buyers_completed').length, 0, String(status));
  }
  const { metrics } = await runScenario({ stage: 'settlement', status: 200, body: { paymentStatus: 'settled', order: { id: 'order', status: 'expired' }, tickets: [] } });
  assert.equal(metrics.filter(m => m.name === 'buyers_completed').length, 0);
  for (const duplicate of [undefined, null, 'true', false, true]) {
    const expired = await runScenario({ stage: 'settlement', status: 200, body: { paymentStatus: 'settled', duplicate, order: { id: 'order', status: 'expired', userId: 'user-0', eventId: 'event', quantity: 2 }, tickets: [] } });
    assert.equal(expired.metrics.filter(m => m.name === 'buyers_completed').length, 0);
    assert.equal(expired.metrics.some(m => m.name === 'protocol_failures'), duplicate !== false, 'first expired ACK requires duplicate false and remains unfinished');
  }
});

test('an excess scheduled iteration fails the run instead of silently passing k6 thresholds', async () => {
  const { metrics, requests } = await runScenario(null, 2);
  assert.equal(requests.length, 0);
  assert.ok(metrics.some(m => m.name === 'unexpected_failures' && m.value === 1));
});

test('raw evidence normalizes offset timestamps and keeps replay/status denominators separate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'peakpass-raw-check-'));
  try {
    const path = join(directory, 'raw.jsonl');
    await writeFile(path, [
      { type: 'Point', metric: 'buyers_started', data: { time: '2026-09-30T17:00:00+09:00', value: 1 } },
      { type: 'Point', metric: 'api_responses', data: { value: 1, tags: { stage: 'checkout', kind: 'normal', flow: 'direct', status: '429', error_code: '0' } } },
      { type: 'Point', metric: 'api_responses', data: { value: 1, tags: { stage: 'checkout', kind: 'replay', flow: 'direct', status: '201', error_code: '0' } } },
    ].map(JSON.stringify).join('\n'));
    const result = await summarizeRaw(path, 2);
    assert.deepEqual(result.arrivalsByUTCSecond, { '2026-09-30T08:00:00': 1 });
    assert.equal(result.startedPerScheduledSecond, 0.5);
    assert.equal(result.responses['checkout/normal/direct/429/0'], 1);
    assert.equal(result.responses['checkout/replay/direct/201/0'], 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function analysisFixture(check) {
  const directory = await mkdtemp(join(tmpdir(), 'peakpass-analysis-check-'));
  const start = Date.parse('2026-10-01T00:00:00Z');
  const point = (metric, buyer, seconds, value = 1, extra = {}) => ({ type: 'Point', metric, data: {
    time: new Date(start + seconds * 1000).toISOString(), value, tags: { buyer: String(buyer), ...extra },
  } });
  const points = [point('scenario_start_ms', 0, 0, start)];
  for (let i = 0; i < 2; i++) {
    points.push(point('buyers_started', i, i), point('active_vus_at_arrival', i, i), point('arrival_lag_ms', i, i, 0),
      point('buyers_completed', i, i + .5, 1, { order_id: `o${i}`, ticket_ids: JSON.stringify([`t${i}`]) }),
      point('journey_outcomes', i, i + .5, 1, { outcome: 'paid' }), point('journey_duration', i, i + .5, 500, { outcome: 'paid' }),
      point('api_responses', i, i + .5, 1, { kind: 'normal', status: '200' }), point('api_duration', i, i + .5, 10, { kind: 'normal', status: '200' }));
  }
  const manifest = { revision: 'flash-sale-v2.6', runId: 'synthetic-analysis', workingTree: '', passed: true, smokePassed: true,
    settings: parseOptions(['--users', '2', '--rate', '1']), fixture: { userIds: ['u0', 'u1'] }, k6ExitCode: 0,
    loadEndedAt: new Date(start + 2000).toISOString(), clockChecks: [0, 1].map(() => ({ offsetMs: 0, roundTripMs: 0 })) };
  const samples = [0, 1000, 2000].map(t => ({ at: new Date(start + t).toISOString(), waiting: 0, checkedOut: 1,
    hostCpuPercent: 1, hostFreeBytes: 4 * 1073741824, generator: { cpuSeconds: 1, processes: [{ path: 'k6', isShim: false, cpuSeconds: 1, memoryBytes: 1 }] },
    containers: ['app', 'postgres', 'redis'].map(service => ({ service, cpuPercent: 1, memoryPercent: 1 })) }));
  const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value));
  try {
    await writeFile(join(directory, 'k6-raw.jsonl'), points.map(JSON.stringify).join('\n'));
    for (const file of ['observations.jsonl', 'resources.jsonl']) await writeFile(join(directory, file), samples.map(JSON.stringify).join('\n'));
    await save('sql-snapshot.json', { orders: [0, 1].map(i => ({ id: `o${i}`, user_id: `u${i}`, status: 'paid' })), tickets: [0, 1].map(i => ({ id: `t${i}`, order_id: `o${i}` })) });
    await save('verification.json', { integrityPassed: true, integrityNames: ['checkoutPaymentIdentity'], counts: {}, checks: {} });
    await save('app-metrics.json', { poolSamples: samples, retrySamples: [] });
    await save('cleanup.json', { passed: true });
    await save('negative-checks.json', { dataUnchanged: true, checks: [0, 1, 2].map(() => ({ status: 401, expected: 401 })) });
    await save('k6-summary.json', { metrics: { buyers_started: { count: 2 }, buyers_completed: { count: 2 }, iterations: { count: 2 }, http_reqs: { count: 2 } } });
    await check({ directory, manifest, save });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('analysis requires an explicitly clean working tree for source attribution', async () => {
  const { analyzeRun } = await import('./flash-sale-analysis.mjs');
  await analysisFixture(async ({ directory, manifest }) => {
    assert.equal((await analyzeRun(directory, manifest)).classification, 'valid-stable');
    for (const workingTree of [' M src/core/services/checkout.service.ts', undefined, null, false, ' ']) {
      const result = await analyzeRun(directory, { ...manifest, workingTree });
      assert.equal(result.classification, 'invalid-measurement', String(workingTree));
      assert.ok(result.invalidReasons.includes('sourceClean'));
    }
  });
});

test('analysis failures preserve strict smoke while still returning a failure', async () => {
  await analysisFixture(async ({ directory, manifest, save }) => {
    const clean = value => redact(value, ['private-secret']);
    for (const passed of [true, false]) {
      for (const failure of ['invalid', 'exception']) {
        const current = { ...manifest, passed, smokePassed: passed, evidenceErrors: [{ step: 'observation', error: 'lost' }] };
        if (failure === 'exception') current.settings = null;
        const error = await harness.finalizeAnalysis(directory, current, save, clean);
        assert.ok(error instanceof Error);
        assert.equal(current.passed, passed, failure);
        assert.equal(current.smokePassed, passed, failure);
        assert.ok(current.analysisError);
        assert.equal(JSON.parse(await readFile(join(directory, 'analysis.json'), 'utf8')).classification, 'invalid-measurement');
      }
      const current = { ...manifest, passed, smokePassed: passed };
      assert.equal(await harness.finalizeAnalysis(directory, current, save, clean), undefined);
      assert.equal(current.passed, passed);
      assert.equal(current.smokePassed, passed);
    }
  });
});

test('accounting requires every offered buyer exactly once including nonpaid journeys', async () => {
  const { metricAccounting } = await import('./flash-sale-analysis.mjs');
  const p = (metric, buyer, outcome) => ({ metric, data: { value: 1, tags: { buyer: String(buyer), ...(outcome ? { outcome } : {}) } } });
  const raw = [];
  for (let i = 0; i < 100; i++) {
    raw.push(p('buyers_started', i), p('active_vus_at_arrival', i), p('arrival_lag_ms', i),
      p('journey_outcomes', i, i === 99 ? 'http_500' : 'paid'), p('journey_duration', i, i === 99 ? 'http_500' : 'paid'));
    if (i < 99) raw.push(p('buyers_completed', i));
  }
  const summary = { buyers_started: { count: 100 }, buyers_completed: { count: 99 }, iterations: { count: 100 } };
  assert.equal(metricAccounting(raw, summary, 100).complete, true);
  for (const buyer of ['100', '99.5', '-1', 'NaN', undefined, '', null, '099', 99]) {
    const changed = raw.map(p => p.data.tags.buyer === '99' ? { ...p, data: { ...p.data, tags: { ...p.data.tags, buyer } } } : p);
    assert.equal(metricAccounting(changed, summary, 100).complete, false, String(buyer));
  }
  assert.equal(metricAccounting(raw, summary, 101).complete, false, 'expected count comes from settings');
});

// ---- flash-sale-v3.0: the arms, the queue journey and its analysis (P8) ----

const queueVUs = ['--pre-vus', '24', '--max-vus', '24'];

test('arm options are validated before provisioning', () => {
  const base = ['--users', '24', '--rate', '2'];
  assert.deepEqual([parseOptions(base).arm, parseOptions(base).pollMode], ['a', null]);
  const b = parseOptions([...base, '--arm', 'b', ...queueVUs]);
  assert.deepEqual([b.arm, b.pollMode, b.hiddenShare, b.monitor], ['b', 'fixed', 0, false]);
  assert.equal(parseOptions([...base, '--arm', 'c', ...queueVUs]).pollMode, 'adaptive');
  // The cutoff leaves the longest request (10 s) and a reserve before k6's drain ends.
  assert.equal(b.cutoffSeconds, b.durationSeconds + b.drainSeconds - 15);
  for (const extra of [['--arm', 'd'], ['--arm', 'B'], ['--arm', 'b'] /* fewer VUs than buyers */,
    ['--arm', 'b', ...queueVUs, '--drain-seconds', '15'], ['--hidden-share', '20'] /* arm a has no tab */,
    ['--arm', 'c', ...queueVUs, '--hidden-share', '101'], ['--arm', 'c', ...queueVUs, '--hidden-share', '-1'], ['--drain-seconds', '901']]) {
    assert.throws(() => parseOptions([...base, ...extra]), extra.join(' '));
  }
  assert.equal(parseOptions([...base, '--drain-seconds', '900']).drainSeconds, 900);
  const layer = parseOptions([...base, '--arm', 'b', ...queueVUs, '--hidden-share', '20', '--monitor']);
  assert.deepEqual([layer.hiddenShare, layer.monitor], [20, true]);
});

test('the Compose file runs Redis without persistence or eviction and turns admission on', async () => {
  const compose = (await readFile(new URL('../docker-compose.flash-sale.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  assert.ok(compose.includes('\n  redis:\n    image: redis:7-alpine\n    command: ["redis-server", "--save", "", "--appendonly", "no", "--maxmemory-policy", "noeviction"]\n'));
  assert.ok(compose.includes('\n      ENABLE_ADMISSION: "true"\n'));
});

test('cleanup deletes admission results before what they reference', () => {
  assert.deepEqual(harness.CLEANUP.map(statement => /^DELETE FROM (\w+)/.exec(statement)[1]),
    ['admission_results', 'tickets', 'payment_records', 'orders', 'reservations', 'events']);
  assert.ok(harness.CLEANUP.every(statement => statement.includes('$1')), 'every statement is bound to the owned event');
});

test('the activation statements are those of the product policy module', async () => {
  const flat = text => text.replace(/\s+/g, ' ');
  const source = flat(await readFile(new URL('../src/infra/postgres/admission-policy.ts', import.meta.url), 'utf8'));
  const a = harness.ACTIVATION;
  assert.ok(source.includes(`const EVENT_GATE = ${a.gate};`));
  assert.ok(source.includes(": 'pg_advisory_xact_lock'}($1::int,hashtext($2))"), 'the exclusive form of the gate');
  assert.equal(a.lock, 'SELECT pg_advisory_xact_lock($1::int,hashtext($2))');
  for (const statement of [a.exists, a.ensure]) assert.ok(source.includes(flat(statement)), statement);
  assert.ok(source.includes("FROM admission_events WHERE event_id=$1 FOR ${mode === 'shared' ? 'SHARE' : 'UPDATE'}"));
  assert.match(a.read, /FROM admission_events WHERE event_id=\$1 FOR UPDATE$/);
  assert.equal(a.protect, 'UPDATE admission_events SET protected=true WHERE event_id=$1');
});

test('the ledger rule is the one of the P7 helper', async () => {
  // A port, because the helper is TypeScript. A change of the helper must be ported: this pins its text.
  assert.equal(harness.sourceHash(await readFile(new URL('../src/tests/helpers/admission-ledger.ts', import.meta.url), 'utf8')), harness.LEDGER_RULE_SOURCE);
  const row = (admissionId, outcome, extra = {}) => ({ admissionId, operation: 'reservation', outcome, targetId: null, errorCode: null, ...extra });
  const entry = (admissionId, state, extra = {}) => ({ admissionId, state, phase: 'idle', ...extra });
  const bought = { fingerprint: 'f', outcome: { kind: 'reservation', resourceId: 'r1' } };
  assert.deepEqual(harness.ledgerMismatches(
    [row('bought', 'consumed', { targetId: 'r1' }), row('sold-out', 'rejected', { errorCode: 'INSUFFICIENT_INVENTORY' }), row('abandoned', 'closed', { errorCode: 'ADMISSION_EXPIRED' })],
    [entry('bought', 'consumed', bought), entry('sold-out', 'consumed', { fingerprint: 'f', outcome: { kind: 'rejected', code: 'INSUFFICIENT_INVENTORY' } }),
      entry('abandoned', 'expired', { fingerprint: 'f', reason: 'ADMISSION_EXPIRED' }), entry('idle', 'expired'), entry('left', 'cancelled'), entry('queued', 'waiting'), entry('inside', 'admitted')]), []);
  assert.deepEqual(harness.ledgerMismatches([row('committed', 'consumed', { targetId: 'r1' })],
    [entry('committed', 'admitted', { phase: 'processing', fingerprint: 'f' }), entry('running', 'admitted', { phase: 'reconciling', fingerprint: 'f' })]), []);
  assert.deepEqual(harness.ledgerMismatches([], [entry('a', 'consumed', bought)]), ['entry a is consumed without a ledger row']);
  assert.deepEqual(harness.ledgerMismatches([], [entry('b', 'expired', { fingerprint: 'f' })]), ['entry b was claimed and expired without a closed row']);
  assert.deepEqual(harness.ledgerMismatches([], [entry('c', 'cancelled', { fingerprint: 'f' }), entry('d', 'cancelled')]), ['entry c was claimed and is cancelled without a ledger row']);
  assert.deepEqual(harness.ledgerMismatches([row('a', 'consumed', { targetId: 'r1' })], []), ['ledger row a (consumed) has no Redis entry']);
  assert.deepEqual(harness.ledgerMismatches([row('a', 'consumed', { targetId: 'r1' })], [entry('a', 'consumed', { fingerprint: 'f', outcome: { kind: 'reservation', resourceId: 'r2' } })]),
    ['ledger row a (consumed) does not match its entry: consumed']);
  assert.deepEqual(harness.ledgerMismatches([row('a', 'closed')], [entry('a', 'consumed', bought)]), ['ledger row a (closed) does not match its entry: consumed']);
});

test('admission evidence is part of integrity, and earlier snapshots keep their verdict', () => {
  const users = [{ id: 'u', checkoutKey: 'ck', callbackKey: 'cb', provider: 'provider' }];
  const settings = parseOptions(['--users', '2', '--rate', '1']);
  const data = { events: [{ id: 'e', available_seats: 4, total_seats: 4 }], reservations: [], orders: [], tickets: [], payments: [], callbackKeys: [] };
  assert.equal(harness.verifySnapshot(data, users, settings, {}, 99).integrityPassed, true);
  assert.equal(harness.verifySnapshot(data, users, settings, {}, 99, { finalRows: [], ledger: [] }).integrityPassed, true);
  const rows = harness.verifySnapshot(data, users, settings, {}, 99, { finalRows: [{ check_name: 'seat_equation' }], ledger: [] });
  assert.deepEqual([rows.integrityPassed, rows.checks.admissionFinalSql], [false, false]);
  const ledger = harness.verifySnapshot(data, users, settings, {}, 99, { finalRows: [], ledger: ['entry a is consumed without a ledger row'] });
  assert.deepEqual([ledger.integrityPassed, ledger.checks.admissionLedger], [false, false]);
  // Evidence that could not be read is not a pass.
  assert.equal(harness.verifySnapshot(data, users, settings, {}, 99, { finalRows: null, ledger: null }).integrityPassed, false);
});
// ---- the queue journey in a vm: the page's real controller file, a virtual clock and a fake queue API ----
// Nothing here is real HTTP or real time. It pins the order of requests, the identities, the polling
// delays and the outcomes; real behaviour is evidence of the fixture runs.

function virtualClock(start = Date.parse('2026-10-05T00:00:00.000Z')) {
  let now = start, ids = 0;
  const timers = new Map();
  return {
    now: () => now,
    set(run, ms = 0, network = false) { timers.set(++ids, { at: now + Math.max(0, Number(ms) || 0), id: ids, run, network }); return ids; },
    clear(id) { timers.delete(id); },
    scriptTimers: () => [...timers.values()].filter(timer => !timer.network).length,
    // Promise jobs settle first, then the earliest timer runs at its own time.
    async step() {
      await new Promise(resolve => setImmediate(resolve));
      const next = [...timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) return false;
      timers.delete(next.id); now = next.at; next.run();
      return true;
    },
  };
}

const QUEUE_EPOCH = '11111111-1111-4111-8111-111111111111';
const purchaseStages = ['reservation', 'checkout', 'settlement'];

async function runQueue({ arm = 'b', iteration = 0, options = [], faults = [], admitAfterMs = 1500, position = 30, latencyMs = 5, fate = null, random = null } = {}) {
  const secret = 'test-webhook-secret', clock = virtualClock(), start = clock.now();
  const settings = parseOptions(['--users', '2', '--rate', '1', '--replay-every', '1', '--arm', arm, '--pre-vus', '2', '--max-vus', '2', ...options]);
  const users = [0, 1].map(i => ({ id: `user-${i}`, token: jwt.sign({ sub: `user-${i}` }, 'a'.repeat(32)), checkoutKey: `checkout-${i}`, callbackKey: `callback-${i}`, provider: `provider-${i}`, joinKey: `join-${i}` }));
  const fixture = { settings, eventId: 'event', tierId: 'standard', users }, user = users[iteration] ?? { id: 'nobody' };
  const requests = [], metrics = [], used = new Set();
  const execution = { scenario: { iterationInTest: iteration, startTime: start }, instance: { vusActive: 1 }, vu: { metrics: { metadata: {} } } };
  let draws = 0;
  const context = createContext({ __ENV: { FS_FIXTURE: 'fixture', FS_BASE_URL: 'http://local', FS_WEBHOOK_SECRET: secret, FS_MODEL: JSON.stringify({ settings, eventId: 'event', tierId: 'standard' }) },
    open: () => JSON.stringify(fixture), Date: { now: clock.now, parse: Date.parse }, JSON,
    Math: random ? Object.assign(Object.create(Math), { random: () => random[draws++ % random.length] }) : Math,
    setTimeout: (run, ms) => clock.set(run, ms), clearTimeout: id => clock.clear(id) });
  // The fake queue API keeps one entry for this buyer and promotes it after `admitAfterMs`.
  let entry = null;
  const iso = ms => new Date(ms).toISOString();
  const admissionBody = () => {
    const now = clock.now();
    if (entry?.state === 'waiting' && fate && now >= entry.joined + fate.afterMs) entry.state = fate.state;
    if (entry?.state === 'waiting' && now >= entry.joined + admitAfterMs) Object.assign(entry, { state: 'admitted', admitted: entry.joined + admitAfterMs });
    const admission = entry && { admissionId: 'admission', epoch: QUEUE_EPOCH, state: entry.state, phase: 'idle', sequence: '1',
      position: entry.state === 'waiting' ? Math.max(1, Math.ceil(position * (1 - (now - entry.joined) / admitAfterMs))) : null,
      joinedAt: iso(entry.joined), admittedAt: entry.admitted ? iso(entry.admitted) : null, expiresAt: iso(now + 30000), reason: null, outcome: null };
    return { contractRevision: 'admission-v1', serverTime: iso(now), queue: { eventId: 'event', epoch: QUEUE_EPOCH, mode: 'open' }, admission,
      nextPollAfterMs: !admission ? null : admission.state === 'waiting' ? (admission.position <= 10 ? 1000 : 5000) : admission.state === 'admitted' ? 1000 : null };
  };
  const order = { id: 'order', status: 'paid', userId: user.id, eventId: 'event', quantity: settings.quantity, tierId: 'standard', reservationId: iteration === 0 ? 'reservation' : null };
  const tickets = Array.from({ length: settings.quantity }, (_, i) => ({ id: `ticket-${i}`, orderId: 'order', userId: user.id, eventId: 'event', status: 'active' }));
  function answer(stage, kind, input) {
    if (stage === 'status') return [200, admissionBody()];
    if (stage === 'join') { entry ??= { state: 'waiting', joined: clock.now(), key: input.joinRequestId }; return [201, admissionBody()]; }
    if (input.admissionId && entry.state === 'admitted') entry.state = 'consumed';
    if (stage === 'reservation') return [201, { id: 'reservation', userId: user.id, eventId: 'event', quantity: settings.quantity, tierId: 'standard', status: 'active' }];
    if (stage === 'checkout') return [201, kind === 'replay' ? { order, tickets } : { order: { ...order, status: 'pending' }, tickets: [] }];
    return [200, { order, paymentStatus: 'settled', tickets, duplicate: false }];
  }
  const http = {
    post() { throw new Error('the queue journey must not block the event loop of its VU'); },
    asyncRequest(method, url, body, params) {
      const input = body ? JSON.parse(body) : null, { stage, kind } = params.tags;
      requests.push({ method, url, body, input, options: params, stage, kind, at: clock.now() });
      if (stage !== 'settlement') assert.equal(jwt.decode(params.headers.Authorization.slice(7)).sub, user.id);
      else assert.equal(params.headers['x-webhook-signature'], createHmac('sha256', secret).update(`${params.headers['x-webhook-timestamp']}.${body}`).digest('hex'));
      const timeout = typeof params.timeout === 'number' ? params.timeout : Number.parseFloat(params.timeout) * 1000;
      const fault = faults.find(f => f.stage === stage && (!f.kind || f.kind === kind) && (!f.once || !used.has(f)) && (f.times === undefined || (f.count ?? 0) < f.times));
      let delay = latencyMs, response;
      if (fault) {
        used.add(fault); fault.count = (fault.count ?? 0) + 1; delay = fault.status === 0 ? timeout : fault.latencyMs ?? latencyMs;
        response = fault.status === 0 ? { status: 0, error_code: 1050, json() { throw new Error('no body'); } }
          : { status: fault.status, error_code: 0, json: () => fault.body ?? { error: { code: fault.code ?? 'INTERNAL_ERROR' } } };
        if (fault.then) fault.then(entry);
      } else { const [status, result] = answer(stage, kind, input); response = { status, error_code: 0, json: () => result }; }
      return new Promise(resolve => clock.set(() => resolve(Object.freeze({ timings: { duration: delay }, headers: fault?.headers ?? {}, ...response })), delay, true));
    },
  };
  class Metric { constructor(name) { this.name = name; } add(value, tags) { metrics.push({ name: this.name, value, tags, metadata: { ...execution.vu.metrics.metadata } }); } }
  const script = await loadScript(context, { 'k6/http': { default: http }, k6: { sleep() { throw new Error('the queue journey must not block the event loop of its VU'); } },
    'k6/metrics': { Counter: Metric, Trend: Metric }, 'k6/execution': { default: execution },
    'k6/data': { SharedArray: class { constructor(_name, factory) { return factory(); } } },
    'k6/crypto': { default: { hmac: (_algorithm, key, value) => createHmac('sha256', key).update(value).digest('hex') } } });
  let leftover = null;
  script.namespace.queued().then(() => { leftover = clock.scriptTimers(); });
  for (let steps = 0; steps < 200000 && (await clock.step()); steps++);
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(leftover, null, 'the iteration ended');
  const events = metrics.filter(m => m.name === 'admission_trace').map(m => ({ ...JSON.parse(m.metadata.e), tags: m.tags }));
  const journeys = metrics.filter(m => m.name === 'admission_journey').map(m => ({ ...JSON.parse(m.metadata.e), tags: m.tags }));
  const outcome = metrics.filter(m => m.name === 'journey_outcomes').map(m => m.tags.outcome);
  return { requests, metrics, events, journeys, outcome, leftover, settings, user, start, deadline: start + settings.cutoffSeconds * 1000,
    stages: requests.map(r => r.stage), of: stage => requests.filter(r => r.stage === stage) };
}

test('a queue buyer reads the status, joins once and buys with its admission', async () => {
  for (const [iteration, arm] of [[0, 'b'], [1, 'c']]) {
    const run = await runQueue({ arm, iteration });
    const purchase = iteration === 0 ? 'reservation' : 'checkout';
    assert.deepEqual(run.outcome, ['paid']);
    assert.deepEqual(run.stages.slice(0, 2), ['status', 'join'], 'the first read gives the epoch, then the join');
    assert.equal(run.requests[0].method, 'GET'); assert.equal(run.requests[0].url, 'http://local/events/event/admissions/me'); assert.equal(run.requests[0].body, null);
    assert.equal(run.of('join').length, 1);
    assert.deepEqual(run.of('join')[0].input, { epoch: QUEUE_EPOCH, joinRequestId: run.user.joinKey });
    assert.ok(run.of('status').length >= 3, 'recover, at least one timer poll and the read after the purchase');
    // The request that consumes the admission carries both admission fields and nothing else new.
    const first = run.of(purchase)[0];
    assert.ok(run.stages.indexOf(purchase) > run.stages.lastIndexOf('join'));
    const plain = { userId: run.user.id, eventId: 'event', tierId: 'standard', quantity: 2 };
    assert.deepEqual(first.input, iteration === 0 ? { ...plain, admissionId: 'admission', admissionEpoch: QUEUE_EPOCH }
      : { ...plain, idempotencyKey: run.user.checkoutKey, admissionId: 'admission', admissionEpoch: QUEUE_EPOCH });
    assert.equal(first.options.headers['Idempotency-Key'], iteration === 0 ? undefined : run.user.checkoutKey);
    assert.equal(first.kind, 'normal');
    // Timeouts are the page's: 5 s for the queue API, 10 s for the purchase.
    assert.ok(run.requests.filter(r => ['status', 'join'].includes(r.stage)).every(r => r.options.timeout === 5000));
    assert.equal(first.options.timeout, 10000);
    if (iteration === 0) {
      // The checkout of the reservation is the existing request: no admission fields.
      const checkout = run.of('checkout')[0];
      assert.deepEqual(checkout.input, { ...plain, reservationId: 'reservation', idempotencyKey: run.user.checkoutKey });
      assert.equal(run.of('reservation').length, 1);
    } else assert.equal(run.of('reservation').length, 0);
    // Replay repeats the checkout and the settlement with their first bodies and keys.
    for (const stage of ['checkout', 'settlement']) {
      const calls = run.of(stage);
      assert.equal(calls.length, 2, stage); assert.equal(calls[0].body, calls[1].body);
      assert.equal(calls[0].options.headers['Idempotency-Key'], calls[1].options.headers['Idempotency-Key']);
      assert.equal(calls[1].kind, 'replay');
    }
    const completion = run.metrics.filter(m => m.name === 'buyers_completed');
    assert.equal(completion.length, 1); assert.equal(completion[0].tags.order_id, 'order');
    assert.deepEqual(JSON.parse(completion[0].tags.ticket_ids), ['ticket-0', 'ticket-1']);
    // One point per request, in both metrics, with the stage of the queue API kept apart.
    for (const name of ['api_responses', 'api_duration']) assert.equal(run.metrics.filter(m => m.name === name).length, run.requests.length, name);
    assert.equal(run.metrics.filter(m => m.name === 'api_responses' && m.tags.stage === 'status').length, run.of('status').length);
    // The trace of the controller and one summary of the buyer.
    assert.ok(run.events.every(e => e.type === e.tags.type && e.tags.buyer === String(iteration)));
    assert.deepEqual([...new Set(run.events.map(e => e.type))].sort(), ['join', 'poll', 'purchase', 'recognition']);
    assert.deepEqual(run.events.filter(e => e.type === 'poll').map(e => e.reason).filter(r => r !== 'timer'), ['recover', 'refresh']);
    assert.equal(run.journeys.length, 1);
    const journey = run.journeys[0], recognition = run.events.find(e => e.type === 'recognition');
    assert.deepEqual([journey.outcome, journey.tags.outcome, journey.mode, journey.hidden], ['paid', 'paid', arm === 'b' ? 'fixed' : 'adaptive', false]);
    assert.deepEqual([journey.admissionId, journey.epoch, journey.joinKey], ['admission', QUEUE_EPOCH, run.user.joinKey]);
    assert.ok(Date.parse(journey.admittedAt) - Date.parse(journey.joinedAt) === 1500);
    assert.deepEqual(journey.recognition, { lowerMs: recognition.lowerMs, upperMs: recognition.upperMs, layer: 'foreground', at: recognition.tApply });
    assert.deepEqual([journey.purchase.attempts, journey.purchase.status, journey.purchaseAttempts], [1, 201, 1]);
    assert.deepEqual(journey.requests, { status: run.of('status').length, join: 1, cancel: 0 });
    assert.equal(journey.traceEvents, run.events.length);
    assert.equal(run.leftover, 0, 'no timer is left when the iteration ends');
    assert.ok(!run.metrics.some(m => ['protocol_failures', 'script_failures'].includes(m.name) && m.value === 1));
  }
});

test('an undecided purchase is repeated with the same identity and counted apart', async () => {
  for (const fault of [{ status: 503, code: 'ADMISSION_UNAVAILABLE' }, { status: 0 }, { status: 409, code: 'ADMISSION_IN_PROGRESS' }, { status: 429, code: 'RATE_LIMITED' }]) {
    const run = await runQueue({ faults: [{ stage: 'reservation', once: true, ...fault }] });
    const attempts = run.of('reservation');
    assert.equal(attempts.length, 2, String(fault.status)); assert.equal(attempts[0].body, attempts[1].body);
    assert.deepEqual(attempts.map(r => r.kind), ['normal', 'retry']);
    assert.deepEqual(run.outcome, ['paid']);
    const keys = run.metrics.filter(m => m.name === 'api_responses' && m.tags.stage === 'reservation').map(m => `${m.tags.kind}/${m.tags.status}`);
    assert.deepEqual(keys, [`normal/${fault.status}`, 'retry/201']);
    assert.equal(run.journeys[0].purchaseAttempts, 2);
  }
  // Four automatic repeats, then the outcome of the last answer; the body never changes.
  for (const [fault, outcome] of [[{ status: 0 }, 'unknown_outcome'], [{ status: 503, code: 'ADMISSION_UNAVAILABLE' }, 'http_503']]) {
    const run = await runQueue({ iteration: 1, faults: [{ stage: 'checkout', ...fault }], options: ['--drain-seconds', '200'] });
    assert.equal(run.of('checkout').length, 5); assert.equal(new Set(run.of('checkout').map(r => r.body)).size, 1);
    assert.deepEqual(run.outcome, [outcome]); assert.equal(run.of('settlement').length, 0); assert.equal(run.leftover, 0);
  }
});

test('planned polling delays are those of contract section 7, computed independently', async () => {
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const timer = run => run.events.filter(e => e.type === 'poll' && e.reason === 'timer');
  const waitLong = { admitAfterMs: 40000, options: ['--drain-seconds', '120'], random: [0.05, 0.95, 0.5, 0.25, 0.75] };
  // Fixed: 1,000 ms whatever base the server sends, no jitter.
  const fixed = timer(await runQueue({ arm: 'b', ...waitLong }));
  assert.ok(fixed.length >= 30 && fixed.some(e => e.baseMs === 5000) && fixed.some(e => e.baseMs === 1000));
  assert.ok(fixed.every(e => e.mode === 'fixed' && e.plannedDelayMs === 1000 && e.u === 0 && e.actualDelayMs === 1000));
  // Adaptive: clamp(base * (1 + 0.2u), 1000, 5000) with u in [-1, 1), cut at both ends.
  const adaptive = timer(await runQueue({ arm: 'c', ...waitLong }));
  assert.ok(adaptive.length >= 10);
  for (const e of adaptive) {
    assert.ok(e.mode === 'adaptive' && e.u >= -1 && e.u < 1);
    assert.equal(e.plannedDelayMs, Math.round(clamp(e.baseMs * (1 + 0.2 * e.u), 1000, 5000)));
    assert.equal(e.actualDelayMs, e.plannedDelayMs);
  }
  assert.ok(adaptive.some(e => e.baseMs === 5000 && e.u > 0 && e.plannedDelayMs === 5000) && adaptive.some(e => e.baseMs === 5000 && e.u < 0 && e.plannedDelayMs < 5000));
  assert.ok(adaptive.some(e => e.baseMs === 1000 && e.u < 0 && e.plannedDelayMs === 1000) && adaptive.some(e => e.baseMs === 1000 && e.u > 0 && e.plannedDelayMs > 1000));
  // Hidden: 15,000 ms in both modes, no jitter.
  for (const arm of ['b', 'c']) {
    const hidden = await runQueue({ arm, ...waitLong, options: [...waitLong.options, '--hidden-share', '100'] });
    assert.ok(timer(hidden).length >= 2 && timer(hidden).every(e => e.hidden === true && e.plannedDelayMs === 15000 && e.u === 0));
    assert.equal(hidden.journeys[0].hidden, true); assert.equal(hidden.journeys[0].recognition.layer, 'hidden');
  }
  // Failure backoff 1 → 2 → 4 → 8 → 15 s with ±20% and the 15 s cap; the identity is kept and nothing is joined meanwhile.
  const failing = await runQueue({ arm: 'c', random: [0.05, 0.95, 0.5, 0.25, 0.75], options: ['--drain-seconds', '120'],
    faults: [{ stage: 'status', status: 503, times: 6, body: { error: { code: 'ADMISSION_UNAVAILABLE' } } }] });
  const retries = failing.events.filter(e => e.type === 'poll' && e.reason === 'retry');
  assert.equal(retries.length, 6);
  [1000, 2000, 4000, 8000, 15000, 15000].forEach((step, i) => {
    assert.equal(retries[i].plannedDelayMs, Math.round(Math.min(15000, step * (1 + 0.2 * retries[i].u))), `failure ${i + 1}`);
    assert.equal(retries[i].actualDelayMs, retries[i].plannedDelayMs);
  });
  assert.ok(failing.of('join')[0].at > failing.of('status')[6].at, 'the join waits for a usable status');
  assert.deepEqual(failing.outcome, ['paid']);
  // A minimum the server asks for wins over the backoff, also above the cap; Retry-After reaches the controller.
  const asked = await runQueue({ options: ['--drain-seconds', '120'], faults: [{ stage: 'status', status: 503, once: true, body: { error: { code: 'ADMISSION_RECOVERING' }, nextPollAfterMs: 20000 } }] });
  assert.equal(asked.events.find(e => e.type === 'poll' && e.reason === 'retry').plannedDelayMs, 20000);
  const limited = await runQueue({ options: ['--drain-seconds', '120'], faults: [{ stage: 'status', status: 429, once: true, headers: { 'Retry-After': '7' }, body: { error: { code: 'ADMISSION_RATE_LIMITED' } } }] });
  assert.equal(limited.events.find(e => e.type === 'poll' && e.reason === 'retry').plannedDelayMs, 7000);
});

test('every way a queue journey ends is one outcome, and nothing starts after the cutoff', async () => {
  const ends = async (expected, input, check = () => {}) => {
    const run = await runQueue(input);
    assert.deepEqual(run.outcome, [expected], expected);
    assert.equal(run.metrics.filter(m => m.name === 'journey_duration').length, 1);
    assert.deepEqual(run.journeys.map(j => j.outcome), [expected]);
    assert.equal(run.metrics.filter(m => m.name === 'buyers_completed').length, expected === 'paid' ? 1 : 0);
    assert.ok(run.metrics.some(m => m.name === 'unexpected_failures' && m.value === 1) === !['paid', 'stock_rejected'].includes(expected));
    assert.ok(run.requests.every(r => r.at < run.deadline), `${expected}: a request started at or after the cutoff`);
    assert.equal(run.leftover, 0, expected);
    assert.ok(!run.metrics.some(m => m.name === 'script_failures' && m.value === 1), expected);
    check(run);
  };
  // drain 30 s with 2 s of arrival: the cutoff is 17 s after the start.
  await ends('queue_waiting', { admitAfterMs: 600000 }, run => {
    assert.equal(run.metrics.find(m => m.name === 'journey_duration').value, 17000);
    assert.ok(run.of('status').length >= 15 && run.of('reservation').length === 0);
    assert.equal(run.journeys[0].phase, 'waiting');
  });
  await ends('not_joined', { faults: [{ stage: 'join', status: 503, code: 'ADMISSION_UNAVAILABLE' }] }, run => {
    assert.ok(run.of('join').length >= 2); assert.equal(new Set(run.of('join').map(r => r.body)).size, 1, 'the same joinRequestId on every attempt');
  });
  await ends('not_joined', { faults: [{ stage: 'status', status: 404, code: 'ADMISSION_NOT_ENABLED' }] }, run => assert.equal(run.of('join').length, 0));
  await ends('admission_expired', { faults: [{ stage: 'reservation', status: 410, code: 'ADMISSION_EXPIRED' }] }, run => assert.equal(run.of('reservation').length, 1));
  await ends('admission_expired', { admitAfterMs: 600000, fate: { state: 'expired', afterMs: 3000 } });
  await ends('cancelled', { admitAfterMs: 600000, fate: { state: 'cancelled', afterMs: 3000 } });
  await ends('cancelled', { faults: [{ stage: 'reservation', status: 410, code: 'ADMISSION_CANCELLED' }] });
  await ends('reset', { faults: [{ stage: 'reservation', status: 410, code: 'ADMISSION_RESET' }] });
  await ends('http_409', { faults: [{ stage: 'reservation', status: 409, code: 'INSUFFICIENT_INVENTORY' }] });
  await ends('stock_rejected', { options: ['--stock', 'limited', '--seats', '2'], faults: [{ stage: 'reservation', status: 409, code: 'INSUFFICIENT_INVENTORY' }] });
  await ends('http_400', { iteration: 1, faults: [{ stage: 'checkout', status: 400, code: 'ADMISSION_INVALID_INPUT' }] });
  await ends('http_409', { faults: [{ stage: 'checkout', status: 409, code: 'CONFLICT' }] });
  await ends('http_500', { faults: [{ stage: 'settlement', status: 500 }] }, run => assert.equal(run.of('settlement').length, 2));
  // Admitted 15.5 s after the join: recognized just before the cutoff, which comes before the think time ends.
  await ends('admitted_unpurchased', { admitAfterMs: 15500, options: ['--think-ms', '5000'] }, run => assert.equal(run.of('reservation').length, 0));
  // The cutoff arrives while the first answer is still out: that answer may come, nothing follows it.
  await ends('incomplete_checkout', { admitAfterMs: 15000, faults: [{ stage: 'reservation', status: 201, latencyMs: 4000,
    body: { id: 'reservation', userId: 'user-0', eventId: 'event', quantity: 2, tierId: 'standard', status: 'active' } }] }, run => {
    assert.equal(run.of('reservation').length, 1); assert.equal(run.of('checkout').length, 0);
    assert.ok(run.of('status').every(r => r.at < run.of('reservation')[0].at + 4000), 'no read of the status after the cutoff either');
  });
  await ends('incomplete_settlement', { iteration: 1, admitAfterMs: 15000, faults: [{ stage: 'checkout', kind: 'normal', status: 201, latencyMs: 4000,
    body: { order: { id: 'order', status: 'pending', userId: 'user-1', eventId: 'event', quantity: 2, tierId: 'standard', reservationId: null }, tickets: [] } }] });
  // An undecided answer after the cutoff is not repeated.
  await ends('http_503', { admitAfterMs: 15000, faults: [{ stage: 'reservation', status: 503, latencyMs: 4000, code: 'ADMISSION_UNAVAILABLE' }] }, run => assert.equal(run.of('reservation').length, 1));
  // A repeat that is waiting when the cutoff arrives is dropped.
  await ends('http_503', { admitAfterMs: 15500, faults: [{ stage: 'reservation', status: 503, code: 'ADMISSION_UNAVAILABLE' }] }, run => assert.ok(run.of('reservation').length <= 2));
  await ends('unknown_outcome', { admitAfterMs: 8000, faults: [{ stage: 'reservation', status: 0 }] }, run => assert.equal(run.of('reservation').length, 1));
});

test('the queue path judges purchase answers as the A path does', async () => {
  const signature = metrics => ({ completed: metrics.filter(m => m.name === 'buyers_completed').length,
    protocol: metrics.filter(m => m.name === 'protocol_failures' && m.value === 1).length, replay: metrics.filter(m => m.name === 'replay_failures' && m.value === 1).length,
    answers: metrics.filter(m => m.name === 'api_responses' && purchaseStages.includes(m.tags.stage)).map(m => [m.tags.stage, m.tags.kind, m.tags.flow, m.tags.status, m.tags.code, m.tags.business].join('/')),
    latencies: metrics.filter(m => m.name === 'api_duration' && purchaseStages.includes(m.tags.stage)).length,
    outcome: metrics.filter(m => m.name === 'journey_outcomes').map(m => m.tags.outcome) });
  const paidOrder = i => ({ id: 'order', status: 'paid', userId: `user-${i}`, eventId: 'event', quantity: 2, tierId: 'standard', reservationId: i === 0 ? 'reservation' : null });
  const tickets = i => [0, 1].map(n => ({ id: `ticket-${n}`, orderId: 'order', userId: `user-${i}`, eventId: 'event', status: 'active' }));
  const cases = [];
  for (const iteration of [0, 1]) {
    cases.push([iteration, null]);
    if (iteration === 0) for (const body of [{ id: 'reservation' }, { id: 'reservation', userId: 'other', eventId: 'event', quantity: 2, tierId: 'standard', status: 'active' },
      { id: 'reservation', userId: 'user-0', eventId: 'event', quantity: 2, tierId: 'standard', status: 'expired' }]) cases.push([0, { stage: 'reservation', status: 201, body }]);
    for (const body of [{ order: { id: 'wrong-order' } }, { order: { ...paidOrder(iteration), status: 'pending' } }, { order: { ...paidOrder(iteration), status: 'pending' }, tickets: tickets(iteration) },
      { order: { ...paidOrder(iteration), status: 'pending', tierId: 'other' }, tickets: [] }]) cases.push([iteration, { stage: 'checkout', kind: 'normal', status: 201, body }]);
    for (const status of [400, 404, 409]) cases.push([iteration, { stage: iteration === 0 ? 'reservation' : 'checkout', kind: 'normal', status, code: 'SOME_REFUSAL' }]);
    for (const body of [{ order: { ...paidOrder(iteration), id: 'different-order' }, tickets: tickets(iteration) }, { order: paidOrder(iteration), tickets: [...tickets(iteration)].reverse() },
      { order: paidOrder(iteration), tickets: [tickets(iteration)[0], tickets(iteration)[0]] }]) cases.push([iteration, { stage: 'checkout', kind: 'replay', status: 201, body }]);
    for (const kind of ['normal', 'replay']) for (const duplicate of [undefined, null, 'false', false, true]) for (const tierId of ['standard', 'other'])
      cases.push([iteration, { stage: 'settlement', kind, status: 200, body: { order: { ...paidOrder(iteration), tierId }, tickets: tickets(iteration), paymentStatus: 'settled', ...(duplicate === undefined ? {} : { duplicate }) } }]);
    cases.push([iteration, { stage: 'settlement', kind: 'normal', status: 200, body: { paymentStatus: 'settled', duplicate: false, order: { id: 'order', status: 'expired', userId: `user-${iteration}`, eventId: 'event', quantity: 2 }, tickets: [] } }]);
    for (const stage of ['settlement', ...(iteration === 0 ? ['checkout'] : [])]) for (const status of [0, 503]) cases.push([iteration, { stage, kind: 'normal', status, once: true, ...(status === 0 ? { body: {} } : {}) }]); // no answer has no body
    for (const status of [401, 403, 429, 500]) cases.push([iteration, { stage: 'settlement', status }]);
  }
  for (const [iteration, fault] of cases) {
    const direct = await runScenario(fault && { ...fault }, iteration);
    const queued = await runQueue({ iteration, faults: fault ? [{ ...fault }] : [], options: ['--think-ms', '0'] });
    assert.deepEqual(signature(queued.metrics), signature(direct.metrics), JSON.stringify([iteration, fault]).slice(0, 160));
  }
});

test('a queue iteration beyond the prepared buyers fails the run instead of passing silently', async () => {
  const run = await runQueue({ iteration: 2 });
  assert.equal(run.requests.length, 0);
  assert.ok(run.metrics.some(m => m.name === 'unexpected_failures' && m.value === 1) && run.metrics.some(m => m.name === 'script_failures' && m.value === 1));
  assert.deepEqual(run.outcome, []);
});
