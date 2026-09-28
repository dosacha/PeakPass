import { v4 as uuid } from 'uuid';
import type { Pool, PoolClient } from 'pg';
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';
import { CheckoutService } from '@/core/services/checkout.service';
import { OrderService } from '@/core/services/order.service';
import { PaymentWebhookService } from '@/core/services/payment-webhook.service';
import { OrderStatus, CreateOrderInput } from '@/core/models/order';

describe('order payment deadline contract (real PostgreSQL)', () => {
  let pool: Pool;
  let client: PoolClient;
  let input: CreateOrderInput;

  beforeAll(async () => { pool = await initPostgresPool(); });
  afterAll(async () => { await closePostgresPool(); });
  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    input = { userId: uuid(), eventId: uuid(), tierId: 'general', quantity: 2, idempotencyKey: uuid() };
    await client.query('INSERT INTO users(id,email) VALUES($1,$2)', [input.userId, `${input.userId}@deadline.test`]);
    await client.query(`INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats,pricing,status)
      VALUES($1,'Deadline',NOW()+INTERVAL '1 hour',NOW()+INTERVAL '2 hours',10,10,$2,'published')`,
    [input.eventId, JSON.stringify([{ id: 'general', name: 'General', price: 50, quantity: 10 }])]);
  });
  afterEach(async () => { await client.query('ROLLBACK'); client.release(); });

  async function checkout(service = new CheckoutService()) {
    const result = await service.checkout(input, client);
    if ('reservationExpired' in result) throw new Error('Unexpected expired reservation');
    return result.order;
  }

  async function deadline(id: string) {
    return (await client.query(`SELECT payment_deadline_at,
      EXTRACT(EPOCH FROM (payment_deadline_at-created_at))::int AS seconds
      FROM orders WHERE id=$1`, [id])).rows[0];
  }

  it('creates a default ten-minute deadline from PostgreSQL creation time in the caller transaction', async () => {
    const order = await checkout();
    expect(order).toEqual(expect.objectContaining({ paymentDeadlineAt: expect.any(Date) }));
    expect(await deadline(order.id)).toEqual({ payment_deadline_at: expect.any(Date), seconds: 600 });
    expect((await client.query('SELECT created_at=NOW() AS same FROM orders WHERE id=$1', [order.id])).rows[0].same).toBe(true);
    expect((await client.query('SELECT available_seats FROM events WHERE id=$1', [input.eventId])).rows[0].available_seats).toBe(8);
    expect((await pool.query('SELECT id FROM orders WHERE id=$1', [order.id])).rowCount).toBe(0);
  });

  it('converts a reservation with a fresh window independent of its remaining hold time', async () => {
    input.reservationId = uuid();
    await client.query(`INSERT INTO reservations(id,user_id,event_id,tier_id,quantity,expires_at)
      VALUES($1,$2,$3,$4,2,NOW()+INTERVAL '20 seconds')`, [input.reservationId, input.userId, input.eventId, input.tierId]);
    await client.query('UPDATE events SET available_seats=8 WHERE id=$1', [input.eventId]);
    const order = await checkout();
    expect((await deadline(order.id)).seconds).toBe(600);
    expect((await client.query(`SELECT r.status,e.available_seats,
      o.payment_deadline_at>r.expires_at AS fresh FROM reservations r
      JOIN orders o ON o.reservation_id=r.id JOIN events e ON e.id=r.event_id WHERE o.id=$1`, [order.id])).rows[0])
      .toEqual({ status: 'converted', available_seats: 8, fresh: true });
  });

  it('does not extend a replay deadline and retains it in every internal order read', async () => {
    const order = await checkout();
    const fixed = new Date('2025-01-01T00:00:00.000Z');
    await client.query('UPDATE orders SET payment_deadline_at=$2 WHERE id=$1', [order.id, fixed]);
    const reads = new OrderService();
    for (const result of [await checkout(), await reads.getOrderById(order.id, client),
      await reads.getOrderByIdForUpdate(order.id, client), await reads.getOrderByIdempotencyKey(input.idempotencyKey, client),
      ...(await reads.getOrdersByUserId(input.userId, 10, 0, client))]) {
      expect(result).toEqual(expect.objectContaining({ id: order.id, paymentDeadlineAt: fixed }));
    }
    expect((await client.query('SELECT COUNT(*)::int AS n FROM payment_records WHERE order_id=$1', [order.id])).rows[0].n).toBe(1);
  });

  it.each([['3', 180], ['1.5', 90]] as const)('uses a %s minute window for actual checkout creation', async (minutes, seconds) => {
    const old = process.env.ORDER_PAYMENT_WINDOW_MINUTES;
    try {
      process.env.ORDER_PAYMENT_WINDOW_MINUTES = minutes;
      jest.resetModules();
      const { CheckoutService: ConfiguredCheckout } = await import('@/core/services/checkout.service');
      const order = await checkout(new ConfiguredCheckout());
      expect((await deadline(order.id)).seconds).toBe(seconds);
    } finally {
      if (old === undefined) delete process.env.ORDER_PAYMENT_WINDOW_MINUTES;
      else process.env.ORDER_PAYMENT_WINDOW_MINUTES = old;
      jest.resetModules();
    }
  });

  it.each(['settled', 'failed'] as const)('keeps the deadline in the %s payment RETURNING projection', async (status) => {
    const order = await checkout();
    const before = await deadline(order.id);
    const result = await new PaymentWebhookService().processPaymentWebhook({ orderId: order.id, status, providerTransactionId: uuid() }, uuid(), client);
    expect(result.order).toEqual(expect.objectContaining({ paymentDeadlineAt: before.payment_deadline_at, status: status === 'settled' ? 'paid' : 'cancelled' }));
    expect(await deadline(order.id)).toEqual(before);
  });

  it('accepts expired distinctly while retaining legacy NULL deadlines and excluding terminal/future rows from lookup', async () => {
    expect(OrderStatus.safeParse('expired').success).toBe(true);
    const ids: string[] = [];
    for (const status of ['pending', 'paid', 'cancelled', 'delivered', 'expired']) {
      const id = uuid(); ids.push(id);
      await client.query(`INSERT INTO orders(id,user_id,event_id,quantity,tier_id,unit_price,total_amount,status,idempotency_key)
        VALUES($1,$2,$3,1,'general',50,50,$4,$5)`, [id, input.userId, input.eventId, status, uuid()]);
    }
    expect((await client.query('SELECT COUNT(*)::int AS n FROM orders WHERE id=ANY($1::uuid[]) AND payment_deadline_at IS NULL', [ids])).rows[0].n).toBe(5);
    const due = [await checkout()];
    input.idempotencyKey = uuid(); due.push(await checkout());
    input.idempotencyKey = uuid(); await checkout();
    await client.query(`UPDATE orders SET payment_deadline_at=NOW()-INTERVAL '1 minute' WHERE id=ANY($1::uuid[])`, [due.map(o => o.id).concat(ids.slice(1))]);
    const sql = `SELECT id FROM orders WHERE status='pending' AND payment_deadline_at IS NOT NULL
      AND payment_deadline_at<=NOW() ORDER BY payment_deadline_at,id LIMIT 10`;
    expect((await client.query(sql)).rows.map(r => r.id)).toEqual(due.map(o => o.id).sort());
    await client.query('SET LOCAL enable_seqscan=off');
    // Verify ordered-index eligibility rather than the optimizer's cost-based choice.
    await client.query('SET LOCAL enable_sort=off');
    expect((await client.query(`EXPLAIN (FORMAT JSON) ${sql}`)).rows[0]['QUERY PLAN'][0].Plan.Plans[0]['Index Name']).toBe('idx_orders_pending_payment_deadline');
  });

  it('persists settled reconciliation facts with existing provider uniqueness and rejects failed reconciliation', async () => {
    const order = await checkout();
    const txn = uuid();
    await client.query(`INSERT INTO payment_records(id,order_id,status,provider_transaction_id,idempotency_key,reconciliation_required)
      VALUES($1,$2,'settled',$3,$4,true)`, [uuid(), order.id, txn, uuid()]);
    expect((await client.query('SELECT status,reconciliation_required FROM payment_records WHERE provider_transaction_id=$1', [txn])).rows[0])
      .toEqual({ status: 'settled', reconciliation_required: true });
    await client.query('SAVEPOINT invalid');
    await expect(client.query(`UPDATE payment_records SET status='failed' WHERE provider_transaction_id=$1`, [txn]))
      .rejects.toMatchObject({ code: '23514', constraint: 'payment_records_reconciliation_settled_check' });
    await client.query('ROLLBACK TO SAVEPOINT invalid');
    await expect(client.query(`INSERT INTO payment_records(id,order_id,status,provider_transaction_id,idempotency_key,reconciliation_required)
      VALUES($1,$2,'settled',$3,$4,true)`, [uuid(), order.id, txn, uuid()])).rejects.toMatchObject({ code: '23505' });
  });
});
