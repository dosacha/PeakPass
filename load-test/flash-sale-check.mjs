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

test('rejects ambiguous arrival models and unsafe run IDs before provisioning', () => {
  for (const args of [['--users', '0'], ['--rate', 'NaN'], ['--users', '11', '--rate', '2'],
    ['--run-id', '../shared'], ['--quantity', '101'], ['--pre-vus', '21', '--max-vus', '20'],
    ['--stock', 'shared'], ['--sample-ms', '0'], ['--retries', '-1'], ['--users', '2000', '--rate', '1000'],
    ['--users', '10010', '--rate', '1001'], ['--users', '2', '--rate', '2']]) {
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
  let faultUsed = false;
  const http = { post(url, body, options) {
    const input = JSON.parse(body), stage = options.tags.stage;
    requests.push({ url, body, input, options, stage });
    if (stage !== 'settlement') assert.equal(jwt.decode(options.headers.Authorization.slice(7)).sub, input.userId);
    else {
      assert.equal(options.headers.Authorization, undefined, 'provider uses HMAC, not a buyer JWT');
      assert.equal(options.headers['x-webhook-signature'], createHmac('sha256', secret).update(`${options.headers['x-webhook-timestamp']}.${body}`).digest('hex'));
    }
    if (fault && stage === fault.stage && (!fault.once || !faultUsed)) {
      faultUsed = true;
      return { status: fault.status, error_code: fault.status === 0 ? 1050 : 0, timings: { duration: 1 }, json: () => fault.body ?? { error: { code: fault.code ?? 'INTERNAL_ERROR' } } };
    }
    const user = users[iteration];
    const order = { id: 'order', status: 'paid', userId: user.id, eventId: 'event', quantity: settings.quantity };
    const result = stage === 'reservation' ? { id: 'reservation' } : stage === 'checkout' ? { order: { ...order, status: 'pending' }, tickets: [] } : {
      order, paymentStatus: 'settled', tickets: Array.from({ length: settings.quantity }, (_, i) => ({ id: `ticket-${i}`, orderId: 'order', userId: user.id, eventId: 'event', status: 'active' })),
    };
    return { status: stage === 'settlement' ? 200 : 201, timings: { duration: 1 }, json: () => result };
  } };
  class Metric { constructor(name) { this.name = name; } add(value, tags) { metrics.push({ name: this.name, value, tags }); } }
  const boundaries = {
    'k6/http': { default: http }, k6: { sleep() {} },
    'k6/metrics': { Counter: Metric, Trend: Metric },
    'k6/execution': { default: { scenario: { iterationInTest: iteration }, instance: { vusActive: 1 } } },
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
  }
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
