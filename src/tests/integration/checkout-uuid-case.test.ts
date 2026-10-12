import { randomUUID as uuid } from 'crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';
import { initRedis, closeRedis } from '@/infra/redis/client';
import { getReservationHold } from '@/infra/redis/commands';
import { getConfig } from '@/infra/config';

// What these tests read of a reservation (top level) and of a checkout answer (`order`).
type PurchaseBody = {
  id: string;
  userId: string;
  eventId: string;
  status: string;
  order: { id: string; userId: string; eventId: string; status: string; reservationId?: string };
  error: { code: string; message: string };
};

// A client may send its ids in upper case. PostgreSQL stores and returns them in lower case, so
// a replay of the same request must be recognised as the same request and not answered 409.
// Real PostgreSQL, Redis and loopback HTTP; each user stays below the default purchase limit.
describe('purchase requests whose UUIDs are sent in upper case', () => {
  let app: FastifyInstance;
  let base: string;
  let pool: Pool;
  let eventId: string;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    pool = await initPostgresPool();
    await initRedis();
    app = await (await import('@/api/app')).createApp();
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await app?.close();
    await closePostgresPool();
    await closeRedis();
  });

  beforeEach(async () => {
    eventId = uuid();
    userId = uuid();
    token = jwt.sign({ sub: userId }, getConfig().JWT_SECRET);
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [
      userId,
      `${userId}@uuid-case.test`,
    ]);
    await pool.query(
      `INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats,pricing,status)
       VALUES($1,'UUID case',NOW()+INTERVAL '1 hour',NOW()+INTERVAL '2 hours',10,10,$2,'published')`,
      [eventId, JSON.stringify([{ id: 'general', name: 'General', price: 50, quantity: 10 }])],
    );
  });

  afterEach(async () => {
    await pool.query(
      'DELETE FROM payment_records WHERE order_id IN (SELECT id FROM orders WHERE event_id=$1)',
      [eventId],
    );
    await pool.query('DELETE FROM orders WHERE event_id=$1', [eventId]);
    await pool.query('DELETE FROM reservations WHERE event_id=$1', [eventId]);
    await pool.query('DELETE FROM events WHERE id=$1', [eventId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  });

  async function post(path: string, payload: object, key?: string) {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        connection: 'close',
        authorization: `Bearer ${token}`,
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: (await response.json()) as PurchaseBody };
  }

  async function orderCount() {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM orders WHERE event_id=$1', [
      eventId,
    ]);
    return result.rows[0].count as number;
  }

  it('replays a direct checkout sent with upper-case ids instead of answering 409', async () => {
    const key = uuid();
    const request = {
      eventId: eventId.toUpperCase(),
      userId: userId.toUpperCase(),
      tierId: 'general',
      quantity: 2,
    };

    const first = await post('/checkouts', request, key);
    expect(first.status).toBe(201);
    expect(first.body.order).toMatchObject({ userId, eventId, status: 'pending' });

    const replay = await post('/checkouts', request, key.toUpperCase());
    expect(replay.status).toBe(201);
    expect(replay.body.order.id).toBe(first.body.order.id);
    expect(await orderCount()).toBe(1);
  });

  it('converts a reservation named in upper case and replays that checkout', async () => {
    const reservation = await post('/reservations', {
      eventId: eventId.toUpperCase(),
      userId: userId.toUpperCase(),
      tierId: 'general',
      quantity: 1,
    });
    expect(reservation.status).toBe(201);
    expect(reservation.body).toMatchObject({ userId, eventId, status: 'active' });

    const key = uuid();
    const request = {
      eventId,
      userId,
      tierId: 'general',
      quantity: 1,
      reservationId: reservation.body.id.toUpperCase(),
    };

    const first = await post('/checkouts', request, key);
    expect(first.status).toBe(201);
    expect(first.body.order.reservationId).toBe(reservation.body.id);

    const replay = await post('/checkouts', request, key);
    expect(replay.status).toBe(201);
    expect(replay.body.order.id).toBe(first.body.order.id);
    expect(await orderCount()).toBe(1);
  });

  it('reports an expired reservation named in upper case as expired and returns its seat', async () => {
    const reservation = await post('/reservations', {
      eventId,
      userId,
      tierId: 'general',
      quantity: 1,
    });
    expect(reservation.status).toBe(201);
    expect(await getReservationHold(reservation.body.id)).not.toBeNull();
    await pool.query(`UPDATE reservations SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1`, [
      reservation.body.id,
    ]);

    const response = await post(
      '/checkouts',
      {
        eventId: eventId.toUpperCase(),
        userId: userId.toUpperCase(),
        tierId: 'general',
        quantity: 1,
        reservationId: reservation.body.id.toUpperCase(),
      },
      uuid(),
    );

    // The same 409 status would also mean "this request does not match the reservation".
    // The message and the returned seat tell the two apart.
    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe('Reservation has expired or is no longer valid');
    const state = await pool.query(
      `SELECT r.status, e.available_seats AS available FROM reservations r
       JOIN events e ON e.id=r.event_id WHERE r.id=$1`,
      [reservation.body.id],
    );
    expect(state.rows[0]).toEqual({ status: 'expired', available: 10 });
    expect(await orderCount()).toBe(0);
    // The hold in Redis is keyed by the id as a string. It goes only if the id was lower-cased.
    expect(await getReservationHold(reservation.body.id)).toBeNull();
  });
});
