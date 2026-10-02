import { v4 as uuid } from 'uuid';
import jwt from 'jsonwebtoken';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { CreateOrderInput } from '@/core/models/order';

process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.RATE_LIMIT_FAIL_MODE = 'open';

describe('event sale eligibility (real PG/Redis/HTTP)', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let secret: string;
  let postgres: typeof import('@/infra/postgres/client');
  let redis: typeof import('@/infra/redis/client');
  let holds: typeof import('@/infra/redis/commands');
  let reservations: typeof import('@/core/services/reservation.service');
  let checkouts: typeof import('@/core/services/checkout.service');
  let payments: typeof import('@/core/services/payment-webhook.service');
  let input: CreateOrderInput;

  beforeAll(async () => {
    secret = (await import('@/infra/config')).loadConfig().JWT_SECRET;
    (await import('@/infra/logger')).initLogger();
    postgres = await import('@/infra/postgres/client');
    redis = await import('@/infra/redis/client');
    holds = await import('@/infra/redis/commands');
    reservations = await import('@/core/services/reservation.service');
    checkouts = await import('@/core/services/checkout.service');
    payments = await import('@/core/services/payment-webhook.service');
    pool = await postgres.initPostgresPool();
    await redis.initRedis();
    app = await (await import('@/api/app')).createApp();
    await app.ready();
  });

  beforeEach(async () => {
    input = { eventId: uuid(), tierId: uuid(), userId: uuid(), quantity: 2, idempotencyKey: uuid() };
    await pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [input.userId, `${input.userId}@sale.test`]);
    await pool.query(`INSERT INTO events (id, name, starts_at, ends_at, total_seats, available_seats, pricing, status)
      VALUES ($1, 'Sale eligibility', NOW() + INTERVAL '1 hour', NOW() + INTERVAL '2 hours', 5, 5, $2, 'published')`,
    [input.eventId, JSON.stringify([{ id: input.tierId, name: 'General', price: 50, quantity: 5 }])]);
    // A new purchase reads the event's admission policy first (admission-v1 §5). Ensure the lazily
    // created policy row here: its first INSERT would otherwise wait on the event row through the
    // foreign key, ahead of the eligibility lock that the lock-order test below observes.
    const { readAdmissionPolicy } = await import('@/infra/postgres/admission-policy');
    await postgres.serializableTransactionWithRetry((client) => readAdmissionPolicy(client, input.eventId));
  });

  afterEach(async () => {
    const rows = await pool.query('SELECT id FROM reservations WHERE event_id = $1', [input.eventId]);
    for (const row of rows.rows) await holds.deleteReservationHold(row.id);
    await pool.query('DELETE FROM tickets WHERE event_id = $1', [input.eventId]);
    await pool.query('DELETE FROM payment_records WHERE order_id IN (SELECT id FROM orders WHERE event_id = $1)', [input.eventId]);
    await pool.query('DELETE FROM orders WHERE event_id = $1', [input.eventId]);
    await pool.query('DELETE FROM reservations WHERE event_id = $1', [input.eventId]);
    await pool.query('DELETE FROM events WHERE id = $1', [input.eventId]);
    await pool.query('DELETE FROM users WHERE id = $1', [input.userId]);
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.closePostgresPool();
    await redis?.closeRedis();
  });

  type Path = 'reservation' | 'direct' | 'conversion';
  async function prepare(path: Path) {
    if (path === 'conversion') input.reservationId = (await new reservations.ReservationService().createReservation(input)).id;
  }
  function request(path: Path) {
    return app.inject({ method: 'POST', url: path === 'reservation' ? '/reservations' : '/checkouts',
      payload: path === 'reservation' ? { eventId: input.eventId, tierId: input.tierId, userId: input.userId, quantity: 2 } : input,
      headers: { authorization: `Bearer ${jwt.sign({ sub: input.userId }, secret, { expiresIn: '1h' })}`,
        ...(path === 'reservation' ? {} : { 'idempotency-key': input.idempotencyKey }) } });
  }
  async function endEvent() {
    await pool.query(`UPDATE events SET starts_at = NOW() - INTERVAL '2 hours', ends_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [input.eventId]);
  }
  async function snapshot() {
    const result = await pool.query(`SELECT available_seats,
      (SELECT COUNT(*)::int FROM orders WHERE event_id = e.id) AS orders,
      (SELECT COUNT(*)::int FROM payment_records p JOIN orders o ON o.id = p.order_id WHERE o.event_id = e.id) AS payments,
      (SELECT COALESCE(jsonb_agg(status ORDER BY id), '[]'::jsonb) FROM reservations WHERE event_id = e.id) AS reservations
      FROM events e WHERE id = $1`, [input.eventId]);
    return result.rows[0];
  }

  for (const path of ['reservation', 'direct', 'conversion'] as const) {
    it.each(['ended', 'draft', 'closed', 'cancelled'])(`rejects %s event on ${path} without acquisition side effects`, async (state) => {
      await prepare(path);
      if (state === 'ended') await endEvent();
      else await pool.query('UPDATE events SET status = $1 WHERE id = $2', [state, input.eventId]);
      const before = await snapshot();
      expect((await request(path)).statusCode).toBe(409);
      expect(await snapshot()).toEqual(before);
      if (input.reservationId) expect(await holds.getReservationHold(input.reservationId)).not.toBeNull();
    });

    it(`accepts future published event on ${path} even before starts_at`, async () => {
      await prepare(path);
      expect((await request(path)).statusCode).toBe(201);
      expect(await snapshot()).toEqual({ available_seats: 3, orders: path === 'reservation' ? 0 : 1,
        payments: path === 'reservation' ? 0 : 1, reservations: path === 'direct' ? [] : [path === 'reservation' ? 'active' : 'converted'] });
    });

    it(`locks event eligibility before inventory mutation on ${path}`, async () => {
      await prepare(path);
      const before = await snapshot();
      const blocker = await pool.connect();
      let pending: ReturnType<typeof request> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [input.eventId]);
        pending = request(path).then((response) => response);
        await waitForEligibilityLock((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        expect(await snapshot()).toEqual(before);
        await blocker.query(`UPDATE events SET status = 'closed' WHERE id = $1`, [input.eventId]);
        await blocker.query('COMMIT');
        expect((await pending).statusCode).toBe(409);
        expect(await snapshot()).toEqual(before);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending;
      }
    });
  }

  async function waitForEligibilityLock(blockerPid: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await pool.query(`SELECT query FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`, [blockerPid]);
      if (result.rows.length > 0) {
        expect(result.rows[0].query).toMatch(/SELECT[\s\S]*ends_at[\s\S]*FROM events[\s\S]*FOR UPDATE/i);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected real PG eligibility row lock waiter');
  }

  it('uses PostgreSQL transaction time for eligibility after wall-clock end passes', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE events SET starts_at = NOW() - INTERVAL '1 hour', ends_at = NOW() + INTERVAL '10 milliseconds' WHERE id = $1`, [input.eventId]);
      await client.query('SELECT pg_sleep(0.05)');
      expect((await client.query('SELECT ends_at > NOW() AS transaction_valid, ends_at < clock_timestamp() AS wall_ended FROM events WHERE id = $1', [input.eventId])).rows[0])
        .toEqual({ transaction_valid: true, wall_ended: true });
      await new reservations.ReservationService().createReservationWithClient(input, client);
      const result = await new checkouts.CheckoutService().checkout(input, client);
      expect('order' in result).toBe(true);
      await client.query('COMMIT');
      expect((await snapshot()).available_seats).toBe(1);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it.each(['direct', 'conversion'] as const)('replays existing %s order after event end', async (path) => {
    await prepare(path);
    const first = await request(path);
    expect(first.statusCode).toBe(201);
    await endEvent();
    const before = await snapshot();
    const replay = await request(path);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().order.id).toBe(first.json().order.id);
    expect(await snapshot()).toEqual(before);
  });

  it('commits expired reservation cleanup after event end before sale rejection', async () => {
    await prepare('conversion');
    await endEvent();
    await pool.query(`UPDATE reservations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [input.reservationId]);
    expect((await request('conversion')).statusCode).toBe(409);
    expect(await snapshot()).toEqual({ available_seats: 5, orders: 0, payments: 0, reservations: ['expired'] });
    expect(await holds.getReservationHold(input.reservationId!)).toBeNull();
  });

  it.each(['failed', 'settled'] as const)('allows existing payment %s after event end', async (status) => {
    const response = await request('direct');
    expect(response.statusCode).toBe(201);
    await endEvent();
    const result = await postgres.serializableTransactionWithRetry((client) => new payments.PaymentWebhookService().processPaymentWebhook(
      { orderId: response.json().order.id, status, providerTransactionId: uuid() }, uuid(), client));
    expect(result.order.status).toBe(status === 'failed' ? 'cancelled' : 'paid');
    expect(result.tickets).toHaveLength(status === 'failed' ? 0 : 2);
    expect((await snapshot()).available_seats).toBe(status === 'failed' ? 5 : 3);
  });
});
