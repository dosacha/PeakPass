import { v4 as uuid } from 'uuid';
import jwt from 'jsonwebtoken';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { CreateOrderInput } from '@/core/models/order';

process.env.ENABLE_ADMIN_EVENT_WRITE = 'true';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.RATE_LIMIT_FAIL_MODE = 'open';

describe('money precision and range (real PG/Redis/HTTP)', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let secret: string;
  let postgres: typeof import('@/infra/postgres/client');
  let redis: typeof import('@/infra/redis/client');
  let holds: typeof import('@/infra/redis/commands');
  let reservations: typeof import('@/core/services/reservation.service');
  let checkouts: typeof import('@/core/services/checkout.service');
  let input: CreateOrderInput;

  beforeAll(async () => {
    secret = (await import('@/infra/config')).loadConfig().JWT_SECRET;
    (await import('@/infra/logger')).initLogger();
    postgres = await import('@/infra/postgres/client');
    redis = await import('@/infra/redis/client');
    holds = await import('@/infra/redis/commands');
    reservations = await import('@/core/services/reservation.service');
    checkouts = await import('@/core/services/checkout.service');
    pool = await postgres.initPostgresPool();
    await redis.initRedis();
    app = await (await import('@/api/app')).createApp();
    await app.ready();
  });

  beforeEach(async () => {
    input = { eventId: uuid(), tierId: uuid(), userId: uuid(), quantity: 2, idempotencyKey: uuid() };
    await pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [input.userId, `${input.userId}@money.test`]);
    await pool.query(`INSERT INTO events (id, name, starts_at, ends_at, total_seats, available_seats, pricing, status)
      VALUES ($1, 'Money contract', NOW() + INTERVAL '1 hour', NOW() + INTERVAL '2 hours', 5, 5, $2, 'published')`,
    [input.eventId, JSON.stringify([{ id: input.tierId, name: 'General', price: 50, quantity: 5 }])]);
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

  type Path = 'direct' | 'conversion';
  async function prepare(path: Path) {
    if (path === 'conversion') input.reservationId = (await new reservations.ReservationService().createReservation(input)).id;
  }
  function request() {
    return app.inject({ method: 'POST', url: '/checkouts',
      payload: input,
      headers: { authorization: `Bearer ${jwt.sign({ sub: input.userId }, secret, { expiresIn: '1h' })}`,
        'idempotency-key': input.idempotencyKey } });
  }
  async function snapshot() {
    const result = await pool.query(`SELECT available_seats,
      (SELECT COUNT(*)::int FROM orders WHERE event_id = e.id) AS orders,
      (SELECT COUNT(*)::int FROM payment_records p JOIN orders o ON o.id = p.order_id WHERE o.event_id = e.id) AS payments,
      (SELECT COALESCE(jsonb_agg(status ORDER BY id), '[]'::jsonb) FROM reservations WHERE event_id = e.id) AS reservations
      FROM events e WHERE id = $1`, [input.eventId]);
    return result.rows[0];
  }


  async function setPrice(price: number) {
    await pool.query('UPDATE events SET pricing = $1 WHERE id = $2',
      [JSON.stringify([{ id: input.tierId, name: 'General', price, quantity: 5 }]), input.eventId]);
  }

  for (const path of ['direct', 'conversion'] as const) {
    it.each([0.005, 12.345, 100000000, 0, -1])(`rejects legacy price %s on ${path} with rollback`, async (price) => {
      await prepare(path);
      await setPrice(price);
      const before = await snapshot();
      const response = await request();
      expect(response.statusCode).toBe(400);
      expect(await snapshot()).toEqual(before);
      if (input.reservationId) expect(await holds.getReservationHold(input.reservationId)).not.toBeNull();
    });
    it(`rejects representable unit price whose quantity overflows on ${path}`, async () => {
      await prepare(path);
      await setPrice(99999999.99);
      const before = await snapshot();
      expect((await request()).statusCode).toBe(400);
      expect(await snapshot()).toEqual(before);
      if (input.reservationId) expect(await holds.getReservationHold(input.reservationId)).not.toBeNull();
    });
  }

  it.each([[0.01, 3, '0.01', '0.03'], [12.34, 3, '12.34', '37.02'],
    [99999999.99, 1, '99999999.99', '99999999.99']] as const)(
    'stores exact decimal price %s times %s and serializes strings', async (price, quantity, unitPrice, totalAmount) => {
      input.quantity = quantity;
      await setPrice(price);
      const response = await request();
      expect(response.statusCode).toBe(201);
      expect(response.json().order).toMatchObject({ unitPrice, totalAmount });
      const row = await pool.query(`SELECT unit_price::text, total_amount::text,
        unit_price * quantity = total_amount AS exact FROM orders WHERE id = $1`, [response.json().order.id]);
      expect(row.rows).toEqual([{ unit_price: unitPrice, total_amount: totalAmount, exact: true }]);
    });

  it.each([0.005, 12.345, 100000000, 99999999.99])('rejects price %s before issuing any order or payment INSERT', async (price) => {
    await setPrice(price);
    const client = await pool.connect();
    const query = jest.spyOn(client, 'query'); // Observation only: all queries execute against real PG.
    try {
      await client.query('BEGIN');
      await expect(new checkouts.CheckoutService().checkout(input, client)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(query.mock.calls.map(([sql]) => String(sql)).filter((sql) => /INSERT INTO (orders|payment_records)/i.test(sql))).toEqual([]);
    } finally {
      query.mockRestore();
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await snapshot()).toEqual({ available_seats: 5, orders: 0, payments: 0, reservations: [] });
  });

  async function createEvent(price: number) {
    return app.inject({ method: 'POST', url: '/events', payload: {
      name: `Money ${input.eventId}`, startsAt: new Date(Date.now() + 3600000).toISOString(),
      endsAt: new Date(Date.now() + 7200000).toISOString(), totalSeats: 1,
      pricing: [{ name: 'General', price, quantity: 1 }],
    }, headers: { authorization: `Bearer ${jwt.sign({ sub: input.userId, role: 'admin' }, secret, { expiresIn: '1h' })}` } });
  }
  it.each([0.005, 12.345, 100000000, 0, -1])('rejects new event price %s at HTTP boundary', async (price) => {
    const response = await createEvent(price);
    try {
      expect(response.statusCode).toBe(400);
      expect((await pool.query('SELECT id FROM events WHERE name = $1', [`Money ${input.eventId}`])).rows).toEqual([]);
    } finally {
      await pool.query('DELETE FROM events WHERE name = $1', [`Money ${input.eventId}`]);
    }
  });
  it.each([0.01, 12.34, 99999999.99])('accepts new event price %s at HTTP boundary', async (price) => {
    const response = await createEvent(price);
    try {
      expect(response.statusCode).toBe(201);
      expect(response.json().pricing[0].price).toBe(price);
    } finally {
      await pool.query('DELETE FROM events WHERE name = $1', [`Money ${input.eventId}`]);
    }
  });

  it('replays current DB order even after legacy tier price becomes invalid', async () => {
    const first = await request();
    expect(first.statusCode).toBe(201);
    await setPrice(0.005);
    await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [first.json().order.id]);
    const before = await snapshot();
    const replay = await request();
    expect(replay.statusCode).toBe(201);
    expect(replay.json().order).toMatchObject({ id: first.json().order.id, status: 'cancelled', unitPrice: '50.00', totalAmount: '100.00' });
    expect(await snapshot()).toEqual(before);
  });
  it('commits expired reservation outcome before legacy price validation', async () => {
    await prepare('conversion');
    await setPrice(0.005);
    await pool.query("UPDATE reservations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [input.reservationId]);
    expect((await request()).statusCode).toBe(409);
    expect(await snapshot()).toEqual({ available_seats: 5, orders: 0, payments: 0, reservations: ['expired'] });
    expect(await holds.getReservationHold(input.reservationId!)).toBeNull();
  });
});
