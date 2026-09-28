import type { Pool } from 'pg';
import { spawn, ChildProcess } from 'child_process';
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';
import { initRedis, closeRedis } from '@/infra/redis/client';
import { getConfig } from '@/infra/config';
import { sweepExpiredOrders } from '@/infra/cron/order-sweeper';
import { fixture, until, lockOrder, blocked, release } from './order-sweeper-fixture';

jest.setTimeout(30000);
describe('order sweeper fairness on real PostgreSQL', () => {
  let pool: Pool;
  let broken: Awaited<ReturnType<typeof fixture>>;
  let healthy: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { pool = await initPostgresPool(); await initRedis(); });
  beforeEach(async () => { broken = await fixture(pool); healthy = await fixture(pool); });
  afterEach(async () => { await broken.cleanup(pool); await healthy.cleanup(pool); });
  afterAll(async () => { await closeRedis(); await closePostgresPool(); });

  async function failingFirstBatch() {
    await broken.order(); await broken.order();
    // Real inventory-ceiling violations: both oldest orders fail on every expiration attempt.
    await pool.query('UPDATE events SET available_seats=10000 WHERE id=$1', [broken.eventId]);
    await pool.query(`UPDATE orders SET payment_deadline_at=NOW()-INTERVAL '1 hour' WHERE event_id=$1`, [broken.eventId]);
  }

  it('advances past a persistently failing entire batch and retains failed orders for retry', async () => {
    await failingFirstBatch();
    for (let i = 0; i < 5; i++) await healthy.order();
    const deadlines = (await pool.query('SELECT id,payment_deadline_at FROM orders WHERE event_id=$1 ORDER BY id', [broken.eventId])).rows;
    const runs = [];
    for (let i = 0; i < 4; i++) runs.push(await sweepExpiredOrders(2));
    const states = await healthy.state();
    process.stdout.write(JSON.stringify({ starvation: { runs, healthy: states.map(row => row.status) } }) + '\n');
    expect(runs[0]).toMatchObject({ scanned: 2, failed: 2, expired: 0 });
    expect(runs[1].oldestOverdueAgeSeconds).toBeGreaterThanOrEqual(3600);
    expect(states.map(row => row.status)).toEqual(Array(5).fill('expired'));
    expect((await broken.state()).map(row => row.status)).toEqual(['pending', 'pending']);
    expect((await pool.query('SELECT id,payment_deadline_at FROM orders WHERE event_id=$1 ORDER BY id', [broken.eventId])).rows).toEqual(deadlines);
    // Repair only the fixture's corruption; retries must still return exactly the held four seats.
    await pool.query('UPDATE events SET available_seats=9996 WHERE id=$1', [broken.eventId]);
    expect((await sweepExpiredOrders(2)).expired).toBe(2);
    expect((await sweepExpiredOrders(2)).expired).toBe(0);
    expect((await broken.state()).map(row => [row.status, row.available_seats, row.tickets])).toEqual([
      ['expired', 10000, 0], ['expired', 10000, 0],
    ]);
  });

  it('persists retry ordering and releases every connection with pool max one', async () => {
    await failingFirstBatch(); await healthy.order(); await healthy.order();
    const config = getConfig(), oldMax = config.DB_POOL_MAX;
    await closePostgresPool(); config.DB_POOL_MAX = 1;
    try {
      pool = await initPostgresPool();
      expect((await sweepExpiredOrders(2)).failed).toBe(2);
      expect((await sweepExpiredOrders(2)).expired).toBe(2);
      expect(pool.totalCount).toBe(1); expect(pool.waitingCount).toBe(0);
      expect((await pool.query('SELECT available_seats FROM events WHERE id=$1', [healthy.eventId])).rows[0].available_seats).toBe(10000);
    } finally {
      await closePostgresPool(); config.DB_POOL_MAX = oldMax; pool = await initPostgresPool();
    }
  });

  it('two workers advance past failures and serialize the same healthy batch exactly once', async () => {
    await failingFirstBatch(); const id = await healthy.order(); await healthy.order();
    expect((await sweepExpiredOrders(2)).failed).toBe(2);
    const lock = await lockOrder(pool, id);
    const first = sweepExpiredOrders(2), second = sweepExpiredOrders(2);
    try { await blocked(pool, lock.pid, 2); } finally { await release(lock.client); }
    const results = await Promise.all([first, second]);
    expect(results.reduce((sum, run) => sum + run.expired, 0)).toBe(2);
    expect((await healthy.state()).map(row => [row.status, row.available_seats, row.tickets])).toEqual([
      ['expired', 10000, 0], ['expired', 10000, 0],
    ]);
    expect((await broken.state()).map(row => row.status)).toEqual(['pending', 'pending']);
  });

  it('a new application process immediately catches up behind failures persisted by its predecessor', async () => {
    await failingFirstBatch(); await healthy.order(); await healthy.order();
    let child: ChildProcess | undefined;
    const pids: number[] = [];
    const start = () => {
      child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
        env: { ...process.env, PORT: '0', LOG_LEVEL: 'error', ORDER_SWEEP_INTERVAL_MS: '60000', ORDER_SWEEP_BATCH_SIZE: '2', DB_POOL_MAX: '1' },
        windowsHide: true, stdio: 'ignore',
      });
      pids.push(child.pid!);
    };
    const stop = async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child!.once('exit', resolve));
        child.kill('SIGKILL'); await exited;
      }
    };
    try {
      start();
      expect(await until(async () => (await pool.query(`SELECT COUNT(*)::int AS count FROM orders
        WHERE event_id=$1 AND expiration_last_failed_at IS NOT NULL`, [broken.eventId])).rows[0].count === 2)).toBe(true);
      expect((await healthy.state()).map(row => row.status)).toEqual(['pending', 'pending']);
      await stop(); start();
      expect(await until(async () => (await healthy.state()).every(row => row.status === 'expired'))).toBe(true);
      expect(pids[0]).not.toBe(pids[1]);
      process.stdout.write(JSON.stringify({ starvationRestart: { pids, states: await healthy.state() } }) + '\n');
      expect((await broken.state()).map(row => row.status)).toEqual(['pending', 'pending']);
    } finally { await stop(); }
  });

  it('clears a 200-order healthy backlog behind a failing batch without enlarging the batch', async () => {
    for (let i = 0; i < 20; i++) await broken.order();
    await pool.query('UPDATE events SET available_seats=10000 WHERE id=$1', [broken.eventId]);
    await pool.query(`UPDATE orders SET payment_deadline_at=NOW()-INTERVAL '1 hour' WHERE event_id=$1`, [broken.eventId]);
    for (let i = 0; i < 200; i++) await healthy.order(false);
    await pool.query('UPDATE orders SET payment_deadline_at=NOW() WHERE event_id=$1', [healthy.eventId]);
    const started = performance.now();
    let expired = 0;
    for (let i = 0; i < 11; i++) expired += (await sweepExpiredOrders(20)).expired;
    const durationMs = performance.now() - started;
    expect(expired).toBe(200);
    expect((await healthy.state()).every(row => row.status === 'expired' && row.available_seats === 10000)).toBe(true);
    expect((await broken.state()).every(row => row.status === 'pending')).toBe(true);
    expect(durationMs).toBeLessThan(60000);
    process.stdout.write(JSON.stringify({ starvationBacklog: { failedPrefix: 20, healthyBacklog: 200, batchSize: 20, expired, durationMs } }) + '\n');
  });
});
