import { randomUUID as uuid } from 'crypto';
import type { Pool } from 'pg';
import { initPostgresPool, closePostgresPool, transaction, serializableTransactionWithRetry } from '@/infra/postgres/client';
import { initRedis, closeRedis, getReadyRedis, withRedis } from '@/infra/redis/client';
import { PaymentWebhookService } from '@/core/services/payment-webhook.service';
import { CheckoutService } from '@/core/services/checkout.service';
import { getConfig } from '@/infra/config';
import { sweepExpiredOrders, startOrderSweeper } from '@/infra/cron/order-sweeper';
import { fixture, until, lockOrder, blocked, release } from './order-sweeper-fixture';
import { execFileSync } from 'child_process';

jest.setTimeout(30000);
describe('bounded order sweeper on real PostgreSQL and Redis', () => {
  let pool: Pool;
  let data: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { pool = await initPostgresPool(); await initRedis(); });
  beforeEach(async () => { data = await fixture(pool); });
  afterEach(async () => { await data.cleanup(pool); });
  afterAll(async () => { await closeRedis(); await closePostgresPool(); });

  it('expires due direct orders, returns seats exactly once, and creates no local failed payment', async () => {
    const id = await data.order();
    expect(await sweepExpiredOrders(10)).toMatchObject({ scanned: 1, expired: 1, skipped: 0, failed: 0, unprocessed: 0 });
    expect((await data.state())[0]).toMatchObject({ status: 'expired', paid_at: null, available_seats: 10000, tickets: 0, reconciliation: 0 });
    expect((await pool.query('SELECT status FROM payment_records WHERE order_id=$1', [id])).rows).toEqual([{ status: 'pending' }]);
    expect(await sweepExpiredOrders(10)).toMatchObject({ scanned: 0, expired: 0, oldestOverdueAgeSeconds: 0 });
  });
  it.each(['future', 'legacy', 'paid', 'cancelled', 'expired', 'delivered'])('excludes %s orders without changing inventory', async kind => {
    const id = await data.order(false);
    if (kind === 'legacy') await pool.query('UPDATE orders SET payment_deadline_at=NULL WHERE id=$1', [id]);
    else if (kind !== 'future') await pool.query(`UPDATE orders SET status=$2,payment_deadline_at=NOW()-INTERVAL '1 hour' WHERE id=$1`, [id, kind]);
    const before = await data.state();
    expect(await sweepExpiredOrders(10)).toMatchObject({ scanned: 0, expired: 0 });
    expect(await data.state()).toEqual(before);
  });
  it('expires converted orders while preserving converted reservation and returning seats once', async () => {
    const rid = uuid();
    await pool.query(`INSERT INTO reservations(id,event_id,user_id,tier_id,quantity,status,expires_at)
      VALUES($1,$2,$3,'general',2,'active',NOW()+INTERVAL '5 minutes')`, [rid, data.eventId, data.userId]);
    await pool.query('UPDATE events SET available_seats=9998 WHERE id=$1', [data.eventId]);
    const result = await transaction(c => new CheckoutService().checkout({ userId: data.userId, eventId: data.eventId,
      tierId: 'general', quantity: 2, reservationId: rid, idempotencyKey: uuid() }, c));
    if ('reservationExpired' in result) throw new Error('Invalid fixture');
    await pool.query(`UPDATE orders SET payment_deadline_at=NOW()-INTERVAL '1 minute' WHERE id=$1`, [result.order.id]);
    expect((await sweepExpiredOrders(10)).expired).toBe(1);
    expect((await data.state())[0]).toMatchObject({ status: 'expired', available_seats: 10000, tickets: 0 });
    expect((await pool.query('SELECT status FROM reservations WHERE id=$1', [rid])).rows[0].status).toBe('converted');
  });
  it('limits a batch and processes the ordered remainder on the next iteration', async () => {
    const ids = [await data.order(), await data.order(), await data.order()].sort();
    await pool.query(`UPDATE orders SET payment_deadline_at=NOW()-INTERVAL '1 minute' WHERE event_id=$1`, [data.eventId]);
    expect(await sweepExpiredOrders(2)).toMatchObject({ scanned: 2, expired: 2 });
    expect((await data.state()).map(r => [r.id, r.status])).toEqual([[ids[0], 'expired'], [ids[1], 'expired'], [ids[2], 'pending']]);
    expect(await sweepExpiredOrders(2)).toMatchObject({ scanned: 1, expired: 1 });
  });
  it('one real constraint failure rolls back its order and does not block a later order', async () => {
    const broken = await data.order();
    const good = await fixture(pool);
    try {
      await good.order();
      await pool.query('UPDATE events SET available_seats=10000 WHERE id=$1', [data.eventId]); // deliberate corrupt inventory
      expect(await sweepExpiredOrders(10)).toMatchObject({ scanned: 2, expired: 1, failed: 1 });
      expect((await data.state())[0]).toMatchObject({ id: broken, status: 'pending', available_seats: 10000 });
      expect((await good.state())[0]).toMatchObject({ status: 'expired', available_seats: 10000 });
    } finally { await good.cleanup(); }
  });
  it('two workers selecting the same locked order return seats once with real serialization retry', async () => {
    const id = await data.order(), lock = await lockOrder(pool, id);
    const a = sweepExpiredOrders(1), b = sweepExpiredOrders(1);
    try { await blocked(pool, lock.pid, 2); } finally { await release(lock.client); }
    const results = await Promise.all([a, b]);
    expect(results.map(r => r.expired).sort()).toEqual([0, 1]);
    expect(results.map(r => r.skipped).sort()).toEqual([0, 1]);
    expect((await data.state())[0]).toMatchObject({ status: 'expired', available_seats: 10000 });
  });
  it('settlement holding the order lock first wins over the worker after deadline', async () => {
    const id = await data.order(), lock = await lockOrder(pool, id);
    const run = sweepExpiredOrders(1);
    try {
      await blocked(pool, lock.pid);
      await new PaymentWebhookService().processPaymentWebhook({ orderId: id, status: 'settled', providerTransactionId: uuid() }, uuid(), lock.client);
    } finally { await release(lock.client); }
    expect(await run).toMatchObject({ expired: 0, skipped: 1 });
    expect((await data.state())[0]).toMatchObject({ status: 'paid', available_seats: 9998, tickets: 2 });
  });
  it('a later successful provider payment remains durable reconciliation after worker expiry', async () => {
    const id = await data.order(); await sweepExpiredOrders(1);
    const providerTransactionId = uuid();
    const pay = () => serializableTransactionWithRetry(c => new PaymentWebhookService().processPaymentWebhook({ orderId: id, status: 'settled', providerTransactionId }, uuid(), c));
    await pay(); await pay();
    expect((await data.state())[0]).toMatchObject({ status: 'expired', available_seats: 10000, tickets: 0, reconciliation: 1 });
  });
  it('never holds a scan connection while acquiring the transaction connection with pool max one', async () => {
    await data.order(); await closePostgresPool();
    const config = getConfig(), old = config.DB_POOL_MAX; config.DB_POOL_MAX = 1;
    try {
      pool = await initPostgresPool();
      expect((await sweepExpiredOrders(10)).expired).toBe(1);
      expect(pool.totalCount).toBe(1); expect(pool.waitingCount).toBe(0);
    } finally { await closePostgresPool(); config.DB_POOL_MAX = old; pool = await initPostgresPool(); }
  });
  it('reports oldest overdue age using database time and a monotonic nonnegative duration', async () => {
    const id = await data.order();
    await pool.query(`UPDATE orders SET payment_deadline_at=NOW()-INTERVAL '123 seconds' WHERE id=$1`, [id]);
    const result = await sweepExpiredOrders(1);
    expect(result.oldestOverdueAgeSeconds).toBeGreaterThanOrEqual(123);
    expect(result.oldestOverdueAgeSeconds).toBeLessThan(130);
    expect(result.durationMs).toBeGreaterThan(0);
  });
  it('uses the pending deadline index for the actual ordered candidate query', async () => {
    await data.order();
    const c = await pool.connect();
    try {
      await c.query('SET enable_seqscan=off');
      const plan = await c.query(`EXPLAIN SELECT id,EXTRACT(EPOCH FROM NOW()-payment_deadline_at)::float8 AS overdue_age_seconds
        FROM orders WHERE status='pending' AND payment_deadline_at IS NOT NULL AND payment_deadline_at<=NOW()
        ORDER BY payment_deadline_at,id LIMIT 10`);
      expect(JSON.stringify(plan.rows)).toContain('idx_orders_pending_payment_deadline');
      process.stdout.write(JSON.stringify({ candidatePlan: plan.rows }) + '\n');
    } finally { await c.query('RESET enable_seqscan'); c.release(); }
  });
  it('has no overlapping ticks while locked and stop awaits current transaction while skipping new orders', async () => {
    const first = await data.order(); await data.order();
    const lock = await lockOrder(pool, first);
    const worker = startOrderSweeper({ intervalMs: 10, batchSize: 10 });
    let released = false;
    try {
      await blocked(pool, lock.pid);
      // Observe the wait across multiple scheduled intervals; duplicates would create extra blocked transactions.
      const end = performance.now() + 100;
      while (performance.now() < end) {
        const rows = await pool.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [lock.pid]);
        expect(rows.rowCount).toBe(1);
      }
      let stopped = false; const stopping = worker.stop().then(() => { stopped = true; });
      expect(stopped).toBe(false);
      await release(lock.client); released = true;
      await stopping;
      expect((await data.state()).map(r => r.status)).toEqual(['expired', 'pending']);
    } finally { if (!released) await release(lock.client); await worker.stop(); }
  });
  it('regular scheduling catches orders that become due after the startup sweep', async () => {
    const id = await data.order(false);
    const worker = startOrderSweeper({ intervalMs: 20, batchSize: 1 });
    try {
      await pool.query(`UPDATE orders SET payment_deadline_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [id]);
      expect(await until(async () => (await data.state())[0].status === 'expired')).toBe(true);
    } finally { await worker.stop(); }
  });
  const destructive = process.env.WAVE3_REDIS_DESTRUCTIVE === '1' ? it : it.skip;
  destructive('commits orders during actual Redis outage and retries no committed business side effects', async () => {
    const name = process.env.WAVE3_REDIS_CONTAINER!, expected = process.env.WAVE3_REDIS_CONTAINER_ID!;
    expect(name).toBe('peakpass-wave3-0928-redis'); expect(getConfig()).toMatchObject({ REDIS_HOST: '127.0.0.1', REDIS_PORT: 63532 });
    const info = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8', windowsHide: true }))[0];
    expect(info.Id).toBe(expected); expect(info.Config.Labels['peakpass.task']).toBe('wave3');
    const id = await data.order();
    try {
      execFileSync('docker', ['stop', name], { windowsHide: true });
      await expect(withRedis(r => r.ping())).rejects.toThrow();
      expect(await sweepExpiredOrders(1)).toMatchObject({ expired: 1, failed: 0 });
      expect((await data.state())[0]).toMatchObject({ id, status: 'expired', available_seats: 10000 });
      expect((await sweepExpiredOrders(1)).expired).toBe(0);
    } finally {
      execFileSync('docker', ['start', name], { windowsHide: true });
      expect(await until(async () => { try { return await (await getReadyRedis()).ping() === 'PONG'; } catch { return false; } })).toBe(true);
    }
  });
  destructive('a Redis disconnect triggered after COMMIT cannot turn an expired order into failed work', async () => {
    const name = process.env.WAVE3_REDIS_CONTAINER!, expected = process.env.WAVE3_REDIS_CONTAINER_ID!;
    expect(name).toBe('peakpass-wave3-0928-redis');
    expect(getConfig()).toMatchObject({ REDIS_HOST: '127.0.0.1', REDIS_PORT: 63532 });
    const info = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8', windowsHide: true }))[0];
    expect(info.Id).toBe(expected); expect(info.Config.Labels['peakpass.task']).toBe('wave3');
    await data.order(); const redis = await getReadyRedis(), del = redis.del.bind(redis);
    let committedBeforeOutage = false;
    // Instrument the real DEL boundary solely to stop the verified container after observing COMMIT.
    const hook = jest.spyOn(redis, 'del').mockImplementationOnce(async (...args) => {
      committedBeforeOutage = (await data.state())[0].status === 'expired';
      execFileSync('docker', ['stop', name], { windowsHide: true });
      return del(...args);
    });
    try {
      expect(await sweepExpiredOrders(1)).toMatchObject({ expired: 1, failed: 0 });
      expect(committedBeforeOutage).toBe(true);
      expect((await data.state())[0]).toMatchObject({ status: 'expired', available_seats: 10000, tickets: 0 });
      expect((await sweepExpiredOrders(1)).expired).toBe(0);
    } finally {
      hook.mockRestore(); execFileSync('docker', ['start', name], { windowsHide: true });
      expect(await until(async () => { try { return await (await getReadyRedis()).ping() === 'PONG'; } catch { return false; } })).toBe(true);
    }
  });
  it('invalidates the event cache only after the database commit', async () => {
    const id = await data.order(), redis = await getReadyRedis();
    const key = `peakpass:event:${data.eventId}`;
    // Cache key comes from the production key contract; DB lock proves invalidation cannot run early.
    await redis.set(key, 'stale');
    const lock = await lockOrder(pool, id), run = sweepExpiredOrders(1);
    try { await blocked(pool, lock.pid); expect(await redis.get(key)).toBe('stale'); }
    finally { await release(lock.client); }
    await run;
    expect((await data.state())[0].status).toBe('expired');
    expect(await redis.get(key)).toBeNull();
  });
});
