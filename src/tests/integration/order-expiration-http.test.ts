// Explicit provider fixture: real HMAC and HTTP, no live payment provider or refund API.
process.env.WEBHOOK_SIGNING_SECRET = 'order-expiration-test-provider-secret';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.ENABLE_DEMO_SESSION = 'true';

import { createHmac, randomUUID as uuid } from 'crypto';
import { execFileSync } from 'child_process';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { initPostgresPool, closePostgresPool, serializableTransactionWithRetry } from '@/infra/postgres/client';
import { initRedis, closeRedis, getReadyRedis, withRedis } from '@/infra/redis/client';
import { invalidateEventCache } from '@/infra/redis/commands';
import { OrderExpirationService } from '@/core/services/order-expiration.service';
import { getConfig } from '@/infra/config';

describe('expired order HTTP acknowledgment and durable reconciliation', () => {
  let app: FastifyInstance;
  let base: string;
  let pool: Pool;
  let userId: string;
  let eventId: string;
  let orderId: string;
  let checkoutKey: string;
  let token: string;

  beforeAll(async () => {
    pool = await initPostgresPool();
    await initRedis();
    app = await (await import('@/api/app')).createApp();
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => { await app?.close(); await closePostgresPool(); await closeRedis(); });
  beforeEach(async () => {
    userId = uuid(); eventId = uuid(); checkoutKey = uuid();
    token = jwt.sign({ sub: userId, role: 'demo' }, getConfig().JWT_SECRET);
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [userId, `${userId}@expiry-http.test`]);
    await pool.query(`INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats,pricing,status)
      VALUES($1,'HTTP expiry',NOW()+INTERVAL '1 hour',NOW()+INTERVAL '2 hours',10,10,$2,'published')`,
    [eventId, JSON.stringify([{ id: 'general', name: 'General', price: 50, quantity: 10 }])]);
    const response = await checkout();
    expect(response.status).toBe(201);
    orderId = (await response.json() as { order: { id: string } }).order.id;
    await pool.query(`UPDATE orders SET payment_deadline_at=NOW()-INTERVAL '1 minute' WHERE id=$1`, [orderId]);
  });
  afterEach(async () => {
    await pool.query('DELETE FROM tickets WHERE event_id=$1', [eventId]);
    await pool.query('DELETE FROM payment_records WHERE order_id IN (SELECT id FROM orders WHERE event_id=$1)', [eventId]);
    await pool.query('DELETE FROM orders WHERE event_id=$1', [eventId]);
    await pool.query('DELETE FROM events WHERE id=$1', [eventId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  });

  function post(path: string, payload: object, headers: Record<string, string>) {
    return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', ...headers }, body: JSON.stringify(payload) });
  }
  function checkout() {
    return post('/checkouts', { eventId, userId, tierId: 'general', quantity: 2 }, {
      authorization: `Bearer ${token}`, 'idempotency-key': checkoutKey,
    });
  }
  function callback(status: 'settled' | 'failed', provider: string, key = uuid(), invalid = false) {
    const payload = { orderId, status, providerTransactionId: provider };
    const timestamp = String(Math.floor(Date.now() / 1000));
    return post('/webhooks/payments/settlement', payload, {
      'idempotency-key': key, 'x-webhook-timestamp': timestamp,
      'x-webhook-signature': invalid ? '00'.repeat(32) : createHmac('sha256', process.env.WEBHOOK_SIGNING_SECRET!)
        .update(`${timestamp}.${JSON.stringify(payload)}`).digest('hex'),
    });
  }
  function expire() {
    return serializableTransactionWithRetry(c => new OrderExpirationService().expirePendingOrderWithClient(orderId, c));
  }
  async function assertExpired(providerCount: number) {
    expect((await pool.query(`SELECT o.status,o.paid_at,e.available_seats,
      (SELECT COUNT(*)::int FROM tickets WHERE order_id=o.id) AS tickets,
      (SELECT COUNT(*)::int FROM payment_records WHERE order_id=o.id AND provider_transaction_id IS NOT NULL) AS payments,
      (SELECT COUNT(*)::int FROM payment_records WHERE order_id=o.id AND status='settled' AND reconciliation_required) AS reconciliation,
      (SELECT COUNT(*)::int FROM reservations WHERE event_id=e.id) AS reservations
      FROM orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1`, [orderId])).rows[0])
      .toEqual({ status: 'expired', paid_at: null, available_seats: 10, tickets: 0, payments: providerCount, reconciliation: providerCount, reservations: 0 });
  }

  it('signed actual HTTP ACK keeps expired business state, rejects invalid HMAC, and checkout ignores stale cache', async () => {
    await expire();
    const redis = await getReadyRedis();
    expect(await redis.get(`peakpass:idempotency:checkout:${checkoutKey}`)).toBeNull();
    const staleKey = `peakpass:idempotency:checkout:${checkoutKey}`;
    await redis.set(staleKey, JSON.stringify({ statusCode: 201, body: { order: { id: orderId, status: 'pending' }, tickets: [] } }));
    try {
      const replay = await checkout();
      expect(replay.status).toBe(201);
      expect(await replay.json()).toMatchObject({ order: { id: orderId, status: 'expired' }, tickets: [] });
    } finally { await redis.del(staleKey); }
    const provider = uuid(); const key = uuid();
    expect((await callback('settled', provider, uuid(), true)).status).toBe(401);
    const first = await callback('settled', provider, key);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toMatchObject({ order: { status: 'expired' }, tickets: [], paymentStatus: 'settled', duplicate: false });
    const cached = await callback('settled', provider, key);
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual(body);
    const uncached = await callback('settled', provider);
    expect(uncached.status).toBe(200);
    expect(await uncached.json()).toMatchObject({ order: { status: 'expired' }, tickets: [], paymentStatus: 'settled', duplicate: true });
    await assertExpired(1);
    expect(await redis.get(`peakpass:idempotency:checkout:${checkoutKey}`)).toBeNull();
  });

  it('contradictory signed events retain successful financial truth in a new process', async () => {
    await expire();
    const provider = uuid();
    for (const status of ['failed', 'settled', 'failed', 'settled'] as const) {
      const response = await callback(status, provider);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ order: { status: 'expired' }, tickets: [] });
    }
    await assertExpired(1);
    const durable = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import pg from 'pg';
      const c=new pg.Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
      await c.connect();
      const r=await c.query('SELECT status,reconciliation_required FROM payment_records WHERE provider_transaction_id=$1',[process.argv[1]]);
      console.log(JSON.stringify({pid:process.pid,rows:r.rows})); await c.end();`, provider], { encoding: 'utf8', windowsHide: true });
    const result = JSON.parse(durable);
    expect(result.pid).not.toBe(process.pid);
    expect(result.rows).toEqual([{ status: 'settled', reconciliation_required: true }]);
    process.stdout.write(JSON.stringify({ parentPid: process.pid, durable: result }) + '\n');
  });

  it('demo settlement uses the same expired outcome and durable reconciliation rule', async () => {
    await expire();
    for (let i = 0; i < 2; i++) {
      const response = await post('/demo/settlement', { orderId }, { authorization: `Bearer ${token}`, 'idempotency-key': uuid() });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ order: { status: 'expired' }, tickets: [], paymentStatus: 'settled', duplicate: i === 1 });
    }
    await assertExpired(1);
  });

  const destructive = process.env.WAVE3_REDIS_DESTRUCTIVE === '1' ? it : it.skip;
  destructive('actual Redis stop after commit cannot undo expiration or reconciliation; recovery preserves replay', async () => {
    await expire();
    const provider = uuid();
    expect((await callback('settled', provider)).status).toBe(200);
    await assertExpired(1); // transaction is visibly committed before Redis is stopped.
    const name = process.env.WAVE3_REDIS_CONTAINER;
    const id = process.env.WAVE3_REDIS_CONTAINER_ID;
    if (name !== 'peakpass-wave3-0928-redis' || !id || process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '63532') {
      throw new Error('Requires the explicit dedicated Wave3 Redis fixture');
    }
    const before = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8', windowsHide: true }))[0];
    expect(before.Id).toBe(id);
    expect(before.Config.Labels['peakpass.task']).toBe('wave3');
    try {
      execFileSync('docker', ['stop', '-t', '0', id], { windowsHide: true });
      await expect(withRedis(redis => redis.ping())).rejects.toThrow();
      await invalidateEventCache(eventId); // actual failed postcommit best-effort effect
      await assertExpired(1);
      expect(await expire()).toMatchObject({ kind: 'already_expired' });
      process.stdout.write(JSON.stringify({ phase: 'committed-then-redis-down', pid: process.pid, orderId }) + '\n');
    } finally {
      execFileSync('docker', ['start', id], { windowsHide: true });
    }
    const deadline = Date.now() + 15000;
    let recovered = false;
    while (!recovered) {
      try { recovered = (await (await getReadyRedis()).ping()) === 'PONG'; } catch {
        if (Date.now() > deadline) throw new Error('Redis fixture failed to recover');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    expect(JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8', windowsHide: true }))[0].Id).toBe(id);
    const response = await callback('settled', provider);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: true, order: { status: 'expired' }, tickets: [] });
    await assertExpired(1);
  }, 45000);
});
