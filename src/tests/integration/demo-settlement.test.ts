process.env.ENABLE_DEMO_SESSION = 'true';

import { randomUUID as uuid } from 'crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';
import { initRedis, closeRedis } from '@/infra/redis/client';
import { getConfig } from '@/infra/config';

// The demo settlement route against real PostgreSQL and Redis: what the unit test of the route
// can only stub. Each user sends one checkout, so the default purchase limit is not reached.
describe('demo settlement on real PostgreSQL and loopback HTTP', () => {
  const quantity = 2;
  let app: FastifyInstance;
  let base: string;
  let pool: Pool;
  let eventId: string;
  let userIds: string[];

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
    userIds = [];
    await pool.query(
      `INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats,pricing,status)
       VALUES($1,'Demo settlement',NOW()+INTERVAL '1 hour',NOW()+INTERVAL '2 hours',10,10,$2,'published')`,
      [eventId, JSON.stringify([{ id: 'general', name: 'General', price: 50, quantity: 10 }])],
    );
  });

  afterEach(async () => {
    await pool.query('DELETE FROM tickets WHERE event_id=$1', [eventId]);
    await pool.query(
      'DELETE FROM payment_callback_keys WHERE order_id IN (SELECT id FROM orders WHERE event_id=$1)',
      [eventId],
    );
    await pool.query(
      'DELETE FROM payment_records WHERE order_id IN (SELECT id FROM orders WHERE event_id=$1)',
      [eventId],
    );
    await pool.query('DELETE FROM orders WHERE event_id=$1', [eventId]);
    await pool.query('DELETE FROM events WHERE id=$1', [eventId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  });

  function post(path: string, payload: object, headers: Record<string, string>) {
    return fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close', ...headers },
      body: JSON.stringify(payload),
    });
  }

  /** A user with a demo-session token and one pending order of `quantity` seats. */
  async function buyerWithPendingOrder() {
    const userId = uuid();
    userIds.push(userId);
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [
      userId,
      `${userId}@demo-settlement.test`,
    ]);
    const token = jwt.sign({ sub: userId, role: 'demo' }, getConfig().JWT_SECRET);
    const response = await post(
      '/checkouts',
      { eventId, userId, tierId: 'general', quantity },
      { authorization: `Bearer ${token}`, 'idempotency-key': uuid() },
    );
    expect(response.status).toBe(201);
    const orderId = ((await response.json()) as { order: { id: string } }).order.id;
    return { token, orderId };
  }

  function settle(token: string, orderId: string, key: string) {
    return post(
      '/demo/settlement',
      { orderId },
      { authorization: `Bearer ${token}`, 'idempotency-key': key },
    );
  }

  async function orderState(orderId: string) {
    const result = await pool.query(
      `SELECT o.status,
        (SELECT COUNT(*)::int FROM tickets WHERE order_id=o.id) AS tickets,
        (SELECT COUNT(*)::int FROM payment_records
          WHERE order_id=o.id AND provider_transaction_id IS NOT NULL) AS settlements
       FROM orders o WHERE o.id=$1`,
      [orderId],
    );
    return result.rows[0];
  }

  it('issues the tickets once: a replay of the same key and a new key add none', async () => {
    const { token, orderId } = await buyerWithPendingOrder();
    const key = uuid();

    const first = await settle(token, orderId, key);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { duplicate: boolean; tickets: { id: string }[] };
    expect(firstBody.duplicate).toBe(false);
    expect(firstBody.tickets).toHaveLength(quantity);
    expect(await orderState(orderId)).toEqual({ status: 'paid', tickets: quantity, settlements: 1 });

    for (const nextKey of [key, uuid()]) {
      const again = await settle(token, orderId, nextKey);
      expect(again.status).toBe(200);
      const body = (await again.json()) as { tickets: { id: string }[] };
      expect(body.tickets.map((ticket) => ticket.id).sort()).toEqual(
        firstBody.tickets.map((ticket) => ticket.id).sort(),
      );
    }
    expect(await orderState(orderId)).toEqual({ status: 'paid', tickets: quantity, settlements: 1 });
  });

  it('answers 404 for an order of another user and leaves that order unpaid', async () => {
    const owner = await buyerWithPendingOrder();
    const stranger = await buyerWithPendingOrder();

    const response = await settle(stranger.token, owner.orderId, uuid());

    expect(response.status).toBe(404);
    expect(await orderState(owner.orderId)).toEqual({ status: 'pending', tickets: 0, settlements: 0 });
  });
});
