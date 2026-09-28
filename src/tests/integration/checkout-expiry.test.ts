import { v4 as uuid } from 'uuid';
import jwt from 'jsonwebtoken';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { CreateOrderInput } from '@/core/models/order';

process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.RATE_LIMIT_FAIL_MODE = 'open';

describe('expired reservation checkout commit boundary (real PG/Redis/HTTP)', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let secret: string;
  let postgres: typeof import('@/infra/postgres/client');
  let redis: typeof import('@/infra/redis/client');
  let holds: typeof import('@/infra/redis/commands');
  let reservations: typeof import('@/core/services/reservation.service');
  let sweeper: typeof import('@/infra/cron/reservation-sweeper');
  let input: CreateOrderInput;
  let strangerId: string;

  beforeAll(async () => {
    const { loadConfig } = await import('@/infra/config');
    secret = loadConfig().JWT_SECRET;
    const { initLogger } = await import('@/infra/logger');
    initLogger();
    postgres = await import('@/infra/postgres/client');
    redis = await import('@/infra/redis/client');
    holds = await import('@/infra/redis/commands');
    reservations = await import('@/core/services/reservation.service');
    sweeper = await import('@/infra/cron/reservation-sweeper');
    pool = await postgres.initPostgresPool();
    await redis.initRedis();
    app = await (await import('@/api/app')).createApp();
    await app.ready();
  });

  beforeEach(async () => {
    input = { eventId: uuid(), tierId: uuid(), userId: uuid(), quantity: 2, idempotencyKey: uuid() };
    strangerId = uuid();
    for (const id of [input.userId, strangerId]) {
      await pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@expiry.test`]);
    }
    await pool.query(
      `INSERT INTO events (id, name, starts_at, ends_at, total_seats, available_seats, pricing, status)
       VALUES ($1, 'Checkout expiry', NOW() + INTERVAL '1 hour', NOW() + INTERVAL '2 hours', 5, 5, $2, 'published')`,
      [input.eventId, JSON.stringify([{ id: input.tierId, name: 'General', price: 50, quantity: 5 }])],
    );
    input.reservationId = (await new reservations.ReservationService().createReservation(input)).id;
    await pool.query(`UPDATE reservations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [input.reservationId]);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await holds.deleteReservationHold(input.reservationId!);
    await pool.query('DELETE FROM payment_records WHERE order_id IN (SELECT id FROM orders WHERE event_id = $1)', [input.eventId]);
    await pool.query('DELETE FROM orders WHERE event_id = $1', [input.eventId]);
    await pool.query('DELETE FROM reservations WHERE event_id = $1', [input.eventId]);
    await pool.query('DELETE FROM events WHERE id = $1', [input.eventId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[input.userId, strangerId]]);
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.closePostgresPool();
    await redis?.closeRedis();
  });

  function checkout(overrides: Partial<CreateOrderInput> = {}) {
    const payload = { ...input, ...overrides };
    return app.inject({ method: 'POST', url: '/checkouts', payload,
      headers: { authorization: `Bearer ${jwt.sign({ sub: payload.userId }, secret, { expiresIn: '1h' })}`,
        'idempotency-key': payload.idempotencyKey } });
  }

  async function snapshot() {
    const result = await pool.query(
      `SELECT r.status, e.available_seats,
       (SELECT COUNT(*)::int FROM orders WHERE event_id = e.id) AS orders,
       (SELECT COUNT(*)::int FROM payment_records p JOIN orders o ON o.id = p.order_id WHERE o.event_id = e.id) AS payments
       FROM reservations r JOIN events e ON e.id = r.event_id WHERE r.id = $1`, [input.reservationId]);
    return result.rows[0];
  }

  const expired = { status: 'expired', available_seats: 5, orders: 0, payments: 0 };
  const active = { status: 'active', available_seats: 3, orders: 0, payments: 0 };

  it('commits expiry and seat return before HTTP 409; repeated requests create no order/payment or extra seats', async () => {
    expect(await snapshot()).toEqual(active);
    expect((await checkout()).statusCode).toBe(409);
    expect(await snapshot()).toEqual(expired);
    expect(await holds.getReservationHold(input.reservationId!)).toBeNull();
    expect((await checkout()).statusCode).toBe(409);
    expect((await checkout({ idempotencyKey: uuid() })).statusCode).toBe(409);
    expect(await snapshot()).toEqual(expired);
  });

  it.each(['owner', 'quantity', 'tier', 'event'] as const)('leaves expired active reservation untouched on %s mismatch', async (field) => {
    const overrides = { owner: { userId: strangerId }, quantity: { quantity: 1 }, tier: { tierId: uuid() }, event: { eventId: uuid() } }[field];
    expect((await checkout(overrides)).statusCode).toBe(409);
    expect(await snapshot()).toEqual(active);
    expect(await holds.getReservationHold(input.reservationId!)).not.toBeNull();
  });

  it('converts a valid reservation and replays its order without returning held seats', async () => {
    await pool.query(`UPDATE reservations SET expires_at = NOW() + INTERVAL '1 hour' WHERE id = $1`, [input.reservationId]);
    const response = await checkout();
    expect(response.statusCode).toBe(201);
    expect((await checkout()).json().order.id).toBe(response.json().order.id);
    expect(await snapshot()).toEqual({ status: 'converted', available_seats: 3, orders: 1, payments: 1 });
  });

  it('rolls back cleanup when real inventory constraint rejects the seat return', async () => {
    await pool.query('UPDATE events SET available_seats = 5 WHERE id = $1', [input.eventId]);
    expect((await checkout()).statusCode).toBe(500);
    expect(await snapshot()).toEqual({ ...active, available_seats: 5 });
    expect(await holds.getReservationHold(input.reservationId!)).not.toBeNull();
  });

  it('returns seats exactly once while checkout and real sweeper both wait for the same reservation lock', async () => {
    const blocker = await pool.connect();
    let pending: Promise<unknown>[] = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM reservations WHERE id = $1 FOR UPDATE', [input.reservationId]);
      const response = checkout().then((value) => value);
      pending = [response];
      await waitForBlockedReservations(1);
      const sweep = sweeper.sweepExpiredReservations();
      pending.push(sweep);
      await waitForBlockedReservations(2);
      await blocker.query('COMMIT');
      expect((await response).statusCode).toBe(409);
      await sweep;
      expect(await snapshot()).toEqual(expired);
      expect(await sweeper.sweepExpiredReservations()).toBe(0);
      expect(await snapshot()).toEqual(expired);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled(pending);
    }
  });

  async function waitForBlockedReservations(count: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await pool.query(`SELECT COUNT(*)::int AS blocked FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%reservations%'`);
      if (result.rows[0].blocked >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected ${count} reservation lock waiters`);
  }

  it('keeps committed expiry when Redis DEL fails (controlled command fault, real DB visibility)', async () => {
    const client = redis.getRedis();
    const original = client.del.bind(client);
    let committedAtDelete: unknown;
    jest.spyOn(client, 'del').mockImplementation(async (...args) => {
      if (JSON.stringify(args).includes(input.reservationId!)) {
        committedAtDelete = await snapshot();
        throw new Error('Injected reservation DEL failure');
      }
      return original(...args);
    });
    expect((await checkout()).statusCode).toBe(409);
    expect(committedAtDelete).toEqual(expired);
    expect(await snapshot()).toEqual(expired);
    expect(await holds.getReservationHold(input.reservationId!)).not.toBeNull();
  });
});

