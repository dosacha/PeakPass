import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import type { Pool } from 'pg';
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';
import { fixture, until, lockOrder, blocked, release } from './order-sweeper-fixture';

// Explicit opt-in: build the current production image, then set WAVE4_TEST_IMAGE to that tag.
const dockerTests = process.env.WAVE4_TEST_IMAGE ? describe : describe.skip;
jest.setTimeout(60000);
dockerTests('order sweeper production Docker lifecycle', () => {
  let pool: Pool;
  let data: Awaited<ReturnType<typeof fixture>>;
  const containers: string[] = [];
  const env = { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info', PORT: '3000',
    DB_HOST: 'host.docker.internal', REDIS_HOST: 'host.docker.internal',
    JWT_SECRET: 'wave4-order-sweeper-production-test-secret-32', API_KEY: 'wave4-test-key',
    WEBHOOK_SIGNING_SECRET: 'wave4-test-webhook-secret', ORDER_SWEEP_INTERVAL_MS: '60000', ORDER_SWEEP_BATCH_SIZE: '25',
    ENFORCE_AUTH_USER_MATCH: 'true', ENABLE_RATE_LIMITING: 'true', RATE_LIMIT_FAIL_MODE: 'closed' };
  const keys = ['NODE_ENV', 'LOG_LEVEL', 'PORT', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
    'REDIS_HOST', 'REDIS_PORT', 'JWT_SECRET', 'API_KEY', 'WEBHOOK_SIGNING_SECRET', 'ORDER_SWEEP_INTERVAL_MS',
    'ORDER_SWEEP_BATCH_SIZE', 'ENFORCE_AUTH_USER_MATCH', 'ENABLE_RATE_LIMITING', 'RATE_LIMIT_FAIL_MODE'];
  function docker(args: string[]) {
    return execFileSync('docker', args, { env, encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
  }
  function start(command: string[] = [], defaults = false) {
    const id = docker(['run', '--detach', '--label', 'peakpass.task=wave4', '--publish', '127.0.0.1::3000',
      ...keys.filter(key => !defaults || !key.startsWith('ORDER_SWEEP_')).flatMap(key => ['--env', key]), process.env.WAVE4_TEST_IMAGE!, ...command]);
    containers.push(id); return id;
  }
  async function ready(id: string) {
    const port = docker(['port', id, '3000/tcp']).split(':').at(-1);
    expect(await until(async () => {
      try { const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer(); return response.status === 200; } catch { return false; }
    }, 20000)).toBe(true);
  }
  async function exited(id: string, code: number) {
    const result = await promisify(execFile)('docker', ['wait', id], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    expect(Number(result.stdout.trim())).toBe(code);
  }
  beforeAll(async () => { pool = await initPostgresPool(); });
  beforeEach(async () => { data = await fixture(pool); });
  afterEach(async () => {
    for (const id of containers.splice(0)) {
      process.stdout.write(JSON.stringify({ container: id, log: docker(['logs', id]) }) + '\n');
      const info = JSON.parse(docker(['inspect', id]))[0];
      process.stdout.write(JSON.stringify({ container: id, health: info.State.Health }) + '\n');
      expect(info.Config.Labels['peakpass.task']).toBe('wave4');
      if (info.State.Running) docker(['kill', id]);
      docker(['rm', id]);
    }
    await data.cleanup();
  });
  afterAll(async () => { await closePostgresPool(); });

  it('catches up on production boot and naturally exits zero on idle SIGTERM', async () => {
    await data.order(); const id = start(); await ready(id);
    expect(await until(async () => (await data.state())[0].status === 'expired')).toBe(true);
    const began = performance.now(); docker(['kill', '--signal', 'TERM', id]); await exited(id, 0);
    process.stdout.write(JSON.stringify({ mode: 'worker-idle', shutdownMs: performance.now() - began,
      requestPattern: 'one consumed readiness response with normal keep-alive' }) + '\n');
    expect((await data.state())[0]).toMatchObject({ status: 'expired', available_seats: 10000, tickets: 0 });
  });
  it('SIGTERM stops new orders and waits for a DB-observed inflight transaction before pool closure', async () => {
    const first = await data.order(); await data.order();
    const lock = await lockOrder(pool, first); let released = false;
    try {
      const id = start(); await ready(id); await blocked(pool, lock.pid);
      const began = performance.now(); docker(['kill', '--signal', 'TERM', id]);
      expect(await until(async () => docker(['logs', id]).includes('종료 절차 시작'))).toBe(true);
      expect(JSON.parse(docker(['inspect', id]))[0].State.Running).toBe(true);
      // PostgreSQL still observes the active transaction while shutdown has begun.
      await blocked(pool, lock.pid);
      const heldMs = performance.now() - began;
      await release(lock.client); released = true;
      const releasedAt = performance.now(); await exited(id, 0);
      process.stdout.write(JSON.stringify({ mode: 'worker-inflight', shutdownMs: performance.now() - began,
        observedLockHoldMs: heldMs, afterLockReleaseMs: performance.now() - releasedAt }) + '\n');
      expect((await data.state()).map(row => row.status)).toEqual(['expired', 'pending']);
      expect((await data.state())[0].available_seats).toBe(9998);
      const logs = docker(['logs', id]);
      expect(logs.indexOf('Order sweeper iteration complete')).toBeLessThan(logs.indexOf('PostgreSQL pool closed'));
    } finally { if (!released) await release(lock.client); }
  });
  it('SIGKILL mid-batch preserves committed terminal work and restart immediately retries uncommitted orders', async () => {
    await data.order(); const second = await data.order(); await data.order();
    const lock = await lockOrder(pool, second); let released = false;
    try {
      const firstProcess = start(); await ready(firstProcess); await blocked(pool, lock.pid);
      expect((await data.state()).map(row => row.status)).toEqual(['expired', 'pending', 'pending']);
      docker(['kill', '--signal', 'KILL', firstProcess]); await exited(firstProcess, 137);
      expect((await data.state()).map(row => row.status)).toEqual(['expired', 'pending', 'pending']);
      await release(lock.client); released = true;
      const restarted = start(); await ready(restarted);
      expect(await until(async () => (await data.state()).every(row => row.status === 'expired'), 3000)).toBe(true);
      expect((await data.state()).map(row => row.available_seats)).toEqual([10000, 10000, 10000]);
      docker(['kill', '--signal', 'TERM', restarted]); await exited(restarted, 0);
    } finally { if (!released) await release(lock.client); }
  });
  it('the actual default production scheduler clears 1000 due orders within 60 seconds with concurrent checkout', async () => {
    // Hand-built initial backlog: one held seat per pending order, all deadlines set by the same PostgreSQL statement.
    await pool.query(`INSERT INTO orders(id,user_id,event_id,quantity,tier_id,unit_price,total_amount,status,idempotency_key,payment_deadline_at)
      SELECT gen_random_uuid(),$1,$2,1,'general',50,50,'pending',gen_random_uuid(),NOW() FROM generate_series(1,1000)`, [data.userId, data.eventId]);
    await pool.query('UPDATE events SET available_seats=9000 WHERE id=$1', [data.eventId]);
    const id = start([], true); await ready(id);
    let checkingOut = true;
    const checkoutMs: number[] = [];
    const checkouts = (async () => {
      while (checkingOut) {
        const began = performance.now(); await data.order(false); checkoutMs.push(performance.now() - began);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })();
    try {
      expect(await until(async () => (await pool.query(`SELECT COUNT(*)::int AS n FROM orders WHERE event_id=$1 AND status='expired'`, [data.eventId])).rows[0].n === 1000, 60000)).toBe(true);
      const completion = (await pool.query(`SELECT MAX(EXTRACT(EPOCH FROM clock_timestamp()-payment_deadline_at))::float8 AS deadline_age_seconds
        FROM orders WHERE event_id=$1 AND status='expired'`, [data.eventId])).rows[0].deadline_age_seconds as number;
      expect(completion).toBeLessThanOrEqual(60);
      checkoutMs.sort((a, b) => a - b);
      process.stdout.write(JSON.stringify({ mode: 'actual-default-production-scheduler', backlog: 1000, completionDeadlineAgeUpperBoundSeconds: completion,
        checkoutCount: checkoutMs.length, checkoutP50Ms: checkoutMs[Math.floor(checkoutMs.length * .5)], checkoutP95Ms: checkoutMs[Math.floor(checkoutMs.length * .95)] }) + '\n');
    } finally { checkingOut = false; await checkouts; docker(['kill', '--signal', 'TERM', id]); await exited(id, 0); }
  }, 90000);
  it('listen startup failure closes worker and resources and exits one naturally', async () => {
    // Native socket occupies the application port in the same production process.
    const id = start(['node', '--input-type=module', '-e',
      "import net from 'node:net'; const s=net.createServer().listen(3000,'0.0.0.0',async()=>{await import('./dist/main.js');}); s.unref();"]);
    await exited(id, 1);
    const log = docker(['logs', id]);
    expect(log).toContain('EADDRINUSE');
    expect(log).toContain('Order sweeper started');
    expect(log).toContain('PostgreSQL pool closed');
    expect(log.indexOf('Order sweeper iteration complete')).toBeLessThan(log.indexOf('PostgreSQL pool closed'));
  });
});
