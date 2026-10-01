// Unit boundary checks; real HTTP/SQL evidence is produced by flash-sale-fixture.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
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
  const script = new SourceTextModule(await readFile(new URL('./flash-sale.js', import.meta.url), 'utf8'), { context });
  await script.link(name => new SyntheticModule(Object.keys(boundaries[name]), function () {
    for (const [key, value] of Object.entries(boundaries[name])) this.setExport(key, value);
  }, { context }));
  await script.evaluate();
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
  assert.equal(metricAccounting(raw, summary).complete, true);
  for (const missing of ['api_duration', 'journey_outcomes', 'journey_duration', 'active_vus_at_arrival', 'arrival_lag_ms']) {
    assert.equal(metricAccounting(raw.filter(p => p.metric !== missing), summary).complete, false, missing);
  }
  assert.equal(metricAccounting(raw.filter(p => !p.metric.startsWith('api_')), summary).complete, false);
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
  assert.equal(metricAccounting(raw, summary).complete, false, '99% paid must not hide one interrupted buyer');
  raw.push(p('journey_outcomes', 99, 'http_500'), p('journey_duration', 99, 'http_500'));
  assert.equal(metricAccounting(raw, { ...summary, iterations: { count: 100 } }).complete, true, 'fully observed failure is valid accounting');
  assert.equal(metricAccounting(raw, summary).complete, false, 'post-finish replay interruption is invalid');
  const duplicate = raw.map(point => point.metric.startsWith('journey_') && point.data.tags.buyer === '99' ? { ...point, data: { ...point.data, tags: { ...point.data.tags, buyer: '98' } } } : point);
  assert.equal(metricAccounting(duplicate, { ...summary, iterations: { count: 100 } }).complete, false, 'duplicate terminal cannot replace a missing buyer');
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
