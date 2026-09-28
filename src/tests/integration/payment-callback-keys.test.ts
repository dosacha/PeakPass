process.env.WEBHOOK_SIGNING_SECRET = 'callback-key-test-provider-secret';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';

import { createHmac, randomUUID as uuid } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { initPostgresPool, closePostgresPool, serializableTransactionWithRetry } from '@/infra/postgres/client';
import { initRedis, closeRedis, getReadyRedis } from '@/infra/redis/client';
import { OrderExpirationService } from '@/core/services/order-expiration.service';
import { PaymentWebhookService } from '@/core/services/payment-webhook.service';
import { ConflictError } from '@/core/errors';
import { fixture } from './order-sweeper-fixture';

describe('durable terminal callback idempotency keys', () => {
  let app: FastifyInstance;
  let base: string;
  let pool: Pool;
  let data: Awaited<ReturnType<typeof fixture>>;
  const keys = new Set<string>();

  beforeAll(async () => {
    pool = await initPostgresPool();
    await initRedis();
    app = await (await import('@/api/app')).createApp();
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => { await app?.close(); await closePostgresPool(); await closeRedis(); });
  beforeEach(async () => { data = await fixture(pool); });
  afterEach(async () => {
    await clearResults();
    keys.clear();
    await data.cleanup();
  });

  async function clearResults() {
    const redis = await getReadyRedis();
    for (const key of keys) await redis.del(`peakpass:idempotency:payment-settlement:${key}`);
  }
  async function callback(orderId: string, status: 'settled' | 'failed', provider: string, key: string) {
    keys.add(key);
    const body = JSON.stringify({ orderId, status, providerTransactionId: provider });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(base + '/webhooks/payments/settlement', {
      method: 'POST', body,
      headers: {
        'content-type': 'application/json', connection: 'close', 'idempotency-key': key,
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': createHmac('sha256', process.env.WEBHOOK_SIGNING_SECRET!)
          .update(`${timestamp}.${body}`).digest('hex'),
      },
    });
    return { status: response.status, body: await response.json() };
  }
  async function expire(orderId: string) {
    expect(await serializableTransactionWithRetry(client =>
      new OrderExpirationService().expirePendingOrderWithClient(orderId, client)))
      .toMatchObject({ kind: 'expired_now' });
  }

  it('retains correction key B after failed(P,A), settled(P,B) and Redis result loss', async () => {
    const order = await data.order();
    await expire(order);
    const provider = uuid(), a = uuid(), b = uuid();
    expect(await callback(order, 'failed', provider, a)).toMatchObject({ status: 200, body: { paymentStatus: 'failed' } });
    expect(await callback(order, 'settled', provider, b)).toMatchObject({
      status: 200, body: { order: { status: 'expired' }, paymentStatus: 'settled', tickets: [] },
    });
    await clearResults();

    const conflicting = await callback(order, 'settled', uuid(), b);
    expect(conflicting.status).toBe(409);
    expect((await pool.query(`SELECT provider_transaction_id, idempotency_key, status, reconciliation_required
      FROM payment_records WHERE order_id=$1 AND provider_transaction_id IS NOT NULL`, [order])).rows)
      .toEqual([{ provider_transaction_id: provider, idempotency_key: a, status: 'settled', reconciliation_required: true }]);
    expect(await data.state()).toEqual([expect.objectContaining({ status: 'expired', available_seats: 10000, tickets: 0, reconciliation: 1 })]);
  });

  it('protects both A and B across providers and orders while replaying the same callback', async () => {
    const order = await data.order(), otherOrder = await data.order();
    await expire(order);
    const provider = uuid(), a = uuid(), b = uuid();
    expect((await callback(order, 'failed', provider, a)).status).toBe(200);
    expect((await callback(order, 'settled', provider, b)).status).toBe(200);
    for (const key of [a, b]) {
      await clearResults();
      expect(await callback(order, key === a ? 'failed' : 'settled', provider, key)).toMatchObject({
        status: 200, body: { duplicate: true, paymentStatus: 'settled', order: { status: 'expired' }, tickets: [] },
      });
      await clearResults();
      expect((await callback(order, 'settled', uuid(), key)).status).toBe(409);
      expect((await callback(otherOrder, 'settled', provider, key)).status).toBe(409);
      expect((await callback(otherOrder, 'settled', uuid(), key)).status).toBe(409);
    }
    expect(await data.state()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: order, status: 'expired', tickets: 0, reconciliation: 1 }),
      expect.objectContaining({ id: otherOrder, status: 'pending', tickets: 0, reconciliation: 0 }),
    ]));
    expect((await pool.query('SELECT available_seats FROM events WHERE id=$1', [data.eventId])).rows[0].available_seats).toBe(9998);
  });

  it('replays the same uppercase UUID callback after Redis loss using the canonical order identity', async () => {
    const order = await data.order(), provider = uuid(), key = uuid();
    expect((await callback(order.toUpperCase(), 'settled', provider, key)).status).toBe(200);
    await clearResults();
    expect(await callback(order.toUpperCase(), 'settled', provider, key)).toMatchObject({
      status: 200, body: { duplicate: true, order: { id: order, status: 'paid' } },
    });
    expect(await data.state()).toEqual([expect.objectContaining({ status: 'paid', available_seats: 9998, tickets: 2 })]);
  });

  it('reserves keys for normal settlement, paid replay, late failure, and cancelled replay', async () => {
    const paid = await data.order(), cancelled = await data.order(), other = await data.order();
    const settledProvider = uuid(), failureProvider = uuid();
    const callbacks = [
      { order: paid, status: 'settled' as const, provider: settledProvider, key: uuid() },
      { order: paid, status: 'settled' as const, provider: settledProvider, key: uuid() },
      { order: paid, status: 'failed' as const, provider: uuid(), key: uuid() },
      { order: cancelled, status: 'failed' as const, provider: failureProvider, key: uuid() },
      { order: cancelled, status: 'failed' as const, provider: failureProvider, key: uuid() },
    ];
    for (const item of callbacks) {
      expect((await callback(item.order, item.status, item.provider, item.key)).status).toBe(200);
      await clearResults();
      expect((await callback(other, 'settled', uuid(), item.key)).status).toBe(409);
    }
    expect(await data.state()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: paid, status: 'paid', tickets: 2, reconciliation: 0 }),
      expect.objectContaining({ id: cancelled, status: 'cancelled', tickets: 0 }),
      expect.objectContaining({ id: other, status: 'pending', tickets: 0 }),
    ]));
    expect((await pool.query('SELECT available_seats FROM events WHERE id=$1', [data.eventId])).rows[0].available_seats).toBe(9996);
  });

  it('serializes the same key across two orders and rolls back the losing settlement', async () => {
    const orders = [await data.order(), await data.order()];
    const key = uuid();
    const inputs = orders.map(orderId => ({ orderId, status: 'settled' as const, providerTransactionId: uuid() }));
    const results = await Promise.allSettled(inputs.map(input => serializableTransactionWithRetry(client =>
      new PaymentWebhookService().processPaymentWebhook(input, key, client))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
    expect((await data.state()).map(row => row.status).sort()).toEqual(['paid', 'pending']);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM tickets WHERE event_id=$1', [data.eventId])).rows[0].count).toBe(2);
  });

  it.each([1, 2])('preserves all five concurrent duplicate keys within the existing retry bound (run %i)', async () => {
    const orderId = await data.order(), providerTransactionId = uuid();
    const results = await Promise.all(Array.from({ length: 5 }, () => {
      const key = uuid();
      return serializableTransactionWithRetry(client => new PaymentWebhookService().processPaymentWebhook(
        { orderId, providerTransactionId, status: 'settled' }, key, client));
    }));
    expect(results.filter(result => !result.duplicate)).toHaveLength(1);
    expect(new Set(results.map(result => result.tickets[0].id)).size).toBe(1);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM payment_callback_keys WHERE order_id=$1', [orderId])).rows[0].count).toBe(5);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM payment_records WHERE provider_transaction_id=$1', [providerTransactionId])).rows[0].count).toBe(1);
    expect(await data.state()).toEqual([expect.objectContaining({ status: 'paid', available_seats: 9998, tickets: 2 })]);
  });

  it('rolls back a rejected transition key and keeps checkout and settlement namespaces separate', async () => {
    const cancelled = await data.order(), other = await data.order();
    expect((await callback(cancelled, 'failed', uuid(), uuid())).status).toBe(200);
    const key = uuid();
    expect((await callback(cancelled, 'settled', uuid(), key)).status).toBe(409);
    expect((await pool.query('SELECT idempotency_key FROM payment_callback_keys WHERE idempotency_key=$1', [key])).rowCount).toBe(0);
    expect((await callback(other, 'settled', uuid(), key)).status).toBe(200);

    const next = await data.order();
    const checkoutKey = (await pool.query('SELECT idempotency_key FROM orders WHERE id=$1', [next])).rows[0].idempotency_key;
    expect((await callback(next, 'settled', uuid(), checkoutKey)).status).toBe(200);
  });

  it('migration backfills legacy terminal keys without consuming checkout keys and enforces DB uniqueness', async () => {
    const order = await data.order(), other = await data.order();
    const provider = uuid(), key = uuid();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Recreate the pre-010 table state only within this rolled-back transaction.
      await client.query('DROP TABLE payment_callback_keys');
      await client.query(`INSERT INTO payment_records(order_id,status,provider_transaction_id,idempotency_key)
        VALUES($1,'failed',$2,$3)`, [order, provider, key]);
      await client.query(readFileSync(join(__dirname, '../../infra/migrations/010_payment_callback_keys.sql'), 'utf8'));
      expect((await client.query('SELECT * FROM payment_callback_keys WHERE order_id=$1', [order])).rows)
        .toEqual([{ idempotency_key: key, order_id: order, provider_transaction_id: provider }]);
      expect((await client.query('SELECT * FROM payment_callback_keys WHERE order_id=$1', [other])).rows).toEqual([]);
      await client.query('SAVEPOINT collision');
      await expect(client.query(`INSERT INTO payment_callback_keys(idempotency_key,order_id,provider_transaction_id)
        VALUES($1,$2,$3)`, [key, other, uuid()])).rejects.toMatchObject({ code: '23505', constraint: 'payment_callback_keys_pkey' });
      await client.query('ROLLBACK TO SAVEPOINT collision');
      expect((await client.query('SELECT status FROM payment_records WHERE provider_transaction_id=$1', [provider])).rows[0].status).toBe('failed');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
