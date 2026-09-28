// Execute the real k6 script with only its k6 module boundaries stubbed.
// Run: node --experimental-vm-modules load-test/payment-callback-check.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const requests = [];
let orders = 0;
const context = createContext({
  __ENV: { LOAD_TEST_USER_ID: 'user', LOAD_TEST_EVENT_ID: 'event', LOAD_TEST_TIER_ID: 'tier' },
  __ITER: 0,
  Math,
  Date,
});
const http = {
  post(url, body, options) {
    if (url.endsWith('/reservations')) return { status: 201, json: () => ({ id: 'reservation' }) };
    if (url.endsWith('/checkouts')) return { status: 201, json: () => ({ order: { id: `order-${++orders}` } }) };
    const input = JSON.parse(body);
    requests.push({ orderId: input.orderId, key: options.headers['Idempotency-Key'] });
    return { status: 200, timings: { duration: 1 }, json: () => ({ order: { id: input.orderId }, paymentStatus: 'settled' }) };
  },
};
class Metric { add() {} }
const boundaries = {
  'k6/http': { default: http },
  k6: { check: (response, checks) => Object.values(checks).every((check) => check(response)), sleep() {} },
  'k6/metrics': { Counter: Metric, Rate: Metric, Trend: Metric },
};
const script = new SourceTextModule(await readFile(new URL('./payment-callback.js', import.meta.url), 'utf8'), { context });
await script.link((name) => {
  const exports = boundaries[name];
  assert.ok(exports, `Unexpected import: ${name}`);
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context });
});
await script.evaluate();
for (let run = 0; run < 2; run++) {
  const data = script.namespace.setup();
  for (let iteration = 0; iteration < 4; iteration++) {
    context.__ITER = iteration;
    script.namespace.default(data);
  }
}
assert.equal(orders, 2);
for (const offset of [0, 4]) {
  assert.equal(requests[offset].key, requests[offset + 2].key, 'Repeated branch must share one key within a run');
  assert.notEqual(requests[offset].key, requests[offset + 1].key, 'Fresh branch must use a different key');
  assert.notEqual(requests[offset + 1].key, requests[offset + 3].key, 'Fresh branch must generate a key each iteration');
}
assert.notEqual(requests[0].key, requests[4].key, 'Separate setup runs must not reuse the callback key');
console.log('PASS: per-run callback key isolation, repeated branch stability, fresh branch independence');
