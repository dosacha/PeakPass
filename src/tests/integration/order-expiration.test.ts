import { randomUUID as uuid } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { initPostgresPool, closePostgresPool, serializableTransactionWithRetry, transaction } from '@/infra/postgres/client';
import { CheckoutService } from '@/core/services/checkout.service';
import { PaymentWebhookService } from '@/core/services/payment-webhook.service';
import { OrderService } from '@/core/services/order.service';
import { OrderExpirationService } from '@/core/services/order-expiration.service';
import type { CreateOrderInput } from '@/core/models/order';

describe('atomic order expiration and provider facts (real PostgreSQL)', () => {
  let pool: Pool;
  let input: CreateOrderInput;
  let orderId: string;
  const payment = new PaymentWebhookService();

  beforeAll(async () => {
    pool = await initPostgresPool();
    process.stdout.write(JSON.stringify((await pool.query('SHOW server_version')).rows[0]) + '\n');
  });
  afterAll(async () => { await closePostgresPool(); });
  beforeEach(async () => {
    input = { userId: uuid(), eventId: uuid(), tierId: 'general', quantity: 2, idempotencyKey: uuid() };
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [input.userId, `${input.userId}@expiry.test`]);
    await pool.query(`INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats,pricing,status)
      VALUES($1,'Expiry',NOW()+INTERVAL '1 hour',NOW()+INTERVAL '2 hours',10,10,$2,'published')`,
    [input.eventId, JSON.stringify([{ id: 'general', name: 'General', price: 50, quantity: 10 }])]);
    orderId = await createOrder();
  });
  afterEach(async () => {
    await pool.query('DELETE FROM tickets WHERE event_id=$1', [input.eventId]);
    await pool.query('DELETE FROM payment_records WHERE order_id IN (SELECT id FROM orders WHERE event_id=$1)', [input.eventId]);
    await pool.query('DELETE FROM orders WHERE event_id=$1', [input.eventId]);
    await pool.query('DELETE FROM reservations WHERE event_id=$1', [input.eventId]);
    await pool.query('DELETE FROM events WHERE id=$1', [input.eventId]);
    await pool.query('DELETE FROM users WHERE id=$1', [input.userId]);
  });

  async function createOrder() {
    const result = await transaction(c => new CheckoutService().checkout(input, c));
    if ('reservationExpired' in result) throw new Error('Fixture reservation expired');
    await pool.query(`UPDATE orders SET payment_deadline_at=NOW()-INTERVAL '1 minute' WHERE id=$1`, [result.order.id]);
    return result.order.id;
  }
  function webhook(status: 'settled' | 'failed', providerTransactionId = uuid(), idempotencyKey = uuid(), id = orderId) {
    return serializableTransactionWithRetry(c => payment.processPaymentWebhook({ orderId: id, status, providerTransactionId }, idempotencyKey, c));
  }
  async function state() {
    const order = (await pool.query('SELECT status,paid_at FROM orders WHERE id=$1', [orderId])).rows[0];
    const inventory = (await pool.query('SELECT available_seats FROM events WHERE id=$1', [input.eventId])).rows[0].available_seats;
    const records = (await pool.query(`SELECT status,reconciliation_required FROM payment_records WHERE order_id=$1 ORDER BY provider_transaction_id NULLS FIRST`, [orderId])).rows;
    const tickets = (await pool.query('SELECT COUNT(*)::int AS n FROM tickets WHERE order_id=$1', [orderId])).rows[0].n;
    const reservations = (await pool.query('SELECT status FROM reservations WHERE event_id=$1', [input.eventId])).rows;
    return { order, inventory, records, tickets, reservations };
  }
  const pendingRecord = { status: 'pending', reconciliation_required: false };
  const settledRecord = { status: 'settled', reconciliation_required: true };
  async function expectExpired(records = [pendingRecord]) {
    expect(await state()).toEqual({ order: { status: 'expired', paid_at: null }, inventory: 10,
      records, tickets: 0, reservations: input.reservationId ? [{ status: 'converted' }] : [] });
  }
  async function expiredFixture() {
    // Pre-implementation RED: reproduce the existing callback against a terminal row with seats already returned.
    await transaction(async c => {
      await c.query("UPDATE orders SET status='expired' WHERE id=$1", [orderId]);
      await c.query('UPDATE events SET available_seats=10 WHERE id=$1', [input.eventId]);
    });
  }

  function expire(client: PoolClient) {
    return new OrderExpirationService().expirePendingOrderWithClient(orderId, client);
  }
  const expireNow = () => serializableTransactionWithRetry(expire);
  type Operation = 'expire' | 'settled' | 'failed';
  function operate(operation: Operation, client: PoolClient, provider = uuid()) {
    return operation === 'expire' ? expire(client)
      : payment.processPaymentWebhook({ orderId, status: operation, providerTransactionId: provider }, uuid(), client);
  }
  async function race(first: Operation, second: Operation) {
    const winner = await pool.connect();
    let loser: Promise<unknown> | undefined;
    try {
      await winner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const winnerPid = (await winner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await new OrderService().getOrderByIdForUpdate(orderId, winner);
      let waiterPid = 0;
      let attempts = 0;
      loser = serializableTransactionWithRetry(async c => {
        attempts++;
        waiterPid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return operate(second, c);
      });
      const deadline = Date.now() + 5000;
      let blockers: number[] = [];
      while (!blockers.includes(winnerPid)) {
        if (Date.now() > deadline) throw new Error('Expected PostgreSQL lock waiter was not observed');
        blockers = waiterPid ? (await pool.query('SELECT pg_blocking_pids($1) AS blockers', [waiterPid])).rows[0].blockers : [];
        await new Promise(resolve => setImmediate(resolve));
      }
      process.stdout.write(JSON.stringify({ first, second, winnerPid, waiterPid, blockers }) + '\n');
      const firstResult = await operate(first, winner);
      await winner.query('COMMIT');
      const secondResult = await loser;
      process.stdout.write(JSON.stringify({ first, second, attempts, state: await state() }) + '\n');
      return { firstResult, secondResult };
    } finally {
      await winner.query('ROLLBACK');
      winner.release();
      await loser?.catch(() => undefined);
    }
  }

  it('direct expiry returns seats exactly once and checkout replays current expired state with the fixed deadline', async () => {
    expect(await expireNow()).toMatchObject({ kind: 'expired_now' });
    const before = (await pool.query('SELECT payment_deadline_at FROM orders WHERE id=$1', [orderId])).rows[0];
    expect(await expireNow()).toMatchObject({ kind: 'already_expired' });
    const replay = await transaction(c => new CheckoutService().checkout(input, c));
    expect(replay).toMatchObject({ order: { id: orderId, status: 'expired', paymentDeadlineAt: before.payment_deadline_at }, tickets: [] });
    await expectExpired();
  });
  it('converted reservation remains converted after order expiry', async () => {
    await expireNow();
    input.idempotencyKey = uuid(); input.reservationId = uuid();
    await pool.query(`INSERT INTO reservations(id,user_id,event_id,tier_id,quantity,expires_at)
      VALUES($1,$2,$3,'general',2,NOW()+INTERVAL '1 minute')`, [input.reservationId, input.userId, input.eventId]);
    await pool.query('UPDATE events SET available_seats=8 WHERE id=$1', [input.eventId]);
    orderId = await createOrder();
    expect(await expireNow()).toMatchObject({ kind: 'expired_now' });
    await expectExpired();
  });
  it.each([
    ['pending', null, 'no_deadline'], ['pending', 'future', 'not_due'],
    ['paid', 'past', 'already_paid'], ['cancelled', 'past', 'cancelled'], ['delivered', 'past', 'delivered'],
  ])('does not expire %s/%s', async (status, deadline, kind) => {
    await pool.query(`UPDATE orders SET status=$2,payment_deadline_at=$3 WHERE id=$1`,
      [orderId, status, deadline === null ? null : new Date(deadline === 'future' ? '2099-01-01' : '2020-01-01')]);
    const before = await state();
    expect(await expireNow()).toMatchObject({ kind });
    expect(await state()).toEqual(before);
  });
  it('throws for a missing order without changing inventory', async () => {
    await expect(transaction(c => new OrderExpirationService().expirePendingOrderWithClient(uuid(), c)))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await state()).inventory).toBe(8);
  });
  it('two expiration transactions return inventory once', async () => {
    expect(await race('expire', 'expire')).toMatchObject({ firstResult: { kind: 'expired_now' }, secondResult: { kind: 'already_expired' } });
    await expectExpired();
  });
  it('settlement holding the order lock first wins even after its deadline', async () => {
    expect(await race('settled', 'expire')).toMatchObject({ secondResult: { kind: 'already_paid' } });
    expect(await state()).toEqual({ order: { status: 'paid', paid_at: expect.any(Date) }, inventory: 8,
      records: [pendingRecord, { status: 'settled', reconciliation_required: false }], tickets: 2, reservations: [] });
    const repeat = await webhook('settled');
    expect(repeat).toMatchObject({ duplicate: true, tickets: [expect.any(Object), expect.any(Object)] });
    expect((await state()).records).toHaveLength(2);
  });
  it('expiration holding the lock first makes concurrent success require reconciliation', async () => {
    expect(await race('expire', 'settled')).toMatchObject({ secondResult: { order: { status: 'expired' }, tickets: [] } });
    await expectExpired([pendingRecord, settledRecord]);
  });
  it('failure holding the lock first cancels and returns inventory only once', async () => {
    expect(await race('failed', 'expire')).toMatchObject({ secondResult: { kind: 'cancelled' } });
    expect(await state()).toEqual({ order: { status: 'cancelled', paid_at: null }, inventory: 10,
      records: [pendingRecord, { status: 'failed', reconciliation_required: false }], tickets: 0, reservations: [] });
  });
  it('expiration holding the lock first preserves expired when failure follows', async () => {
    await race('expire', 'failed');
    await expectExpired([pendingRecord, { status: 'failed', reconciliation_required: false }]);
  });
  it('rollback and a retriable transaction error undo inventory and status together', async () => {
    let attempts = 0;
    const result = await serializableTransactionWithRetry(async c => {
      attempts++;
      const outcome = await expire(c);
      if (attempts === 1) throw Object.assign(new Error('Injected serialization rollback'), { code: '40001' });
      return outcome;
    });
    expect(attempts).toBe(2);
    expect(result.kind).toBe('expired_now');
    await expectExpired();
  });
  it('failed-then-success and success-then-failure preserve one successful provider fact across duplicates', async () => {
    await expireNow();
    const provider = uuid();
    await webhook('failed', provider);
    expect(await webhook('settled', provider)).toMatchObject({ duplicate: false, paymentStatus: 'settled' });
    for (const status of ['settled', 'failed', 'settled'] as const) {
      expect(await webhook(status, provider)).toMatchObject({ duplicate: true, paymentStatus: 'settled', order: { status: 'expired' }, tickets: [] });
    }
    await expectExpired([pendingRecord, settledRecord]);
    await closePostgresPool(); pool = await initPostgresPool();
    await expectExpired([pendingRecord, settledRecord]);
  });
  it('distinct successful provider identities are retained and cross-order reuse is rejected', async () => {
    await expireNow();
    const provider = uuid();
    await webhook('settled', provider);
    await webhook('settled');
    await expectExpired([pendingRecord, settledRecord, settledRecord]);
    input.idempotencyKey = uuid();
    const other = await createOrder();
    await expect(webhook('settled', provider, uuid(), other)).rejects.toMatchObject({ code: 'CONFLICT' });
    await transaction(async c => {
      await c.query("UPDATE orders SET status='expired' WHERE id=$1", [other]);
      await c.query('UPDATE events SET available_seats=10 WHERE id=$1', [input.eventId]);
    });
    await expect(webhook('settled', provider, uuid(), other)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expectExpired([pendingRecord, settledRecord, settledRecord]);
  });
  it('different provider identities cannot reuse a terminal idempotency key', async () => {
    await expireNow();
    const key = uuid();
    await webhook('settled', uuid(), key);
    await expect(webhook('settled', uuid(), key)).rejects.toMatchObject({
      code: 'CONFLICT', statusCode: 409, message: 'Idempotency key already used for a different payment callback',
    });
    await expectExpired([pendingRecord, settledRecord]);
  });

  it('late success preserves expired order and persists a settled reconciliation fact without tickets', async () => {
    await expiredFixture();
    const result = await webhook('settled');
    expect(result).toMatchObject({ order: { status: 'expired' }, tickets: [], paymentStatus: 'settled', duplicate: false });
    await expectExpired([pendingRecord, settledRecord]);
  });
  it('late failure neither cancels expired order nor returns its inventory twice', async () => {
    await expiredFixture();
    const result = await webhook('failed');
    expect(result).toMatchObject({ order: { status: 'expired' }, tickets: [], paymentStatus: 'failed' });
    await expectExpired([pendingRecord, { status: 'failed', reconciliation_required: false }]);
  });
  it('a success after a failure for the same provider identity upgrades the durable fact', async () => {
    await expiredFixture();
    const provider = uuid();
    await pool.query(`INSERT INTO payment_records(id,order_id,status,provider_transaction_id,idempotency_key)
      VALUES($1,$2,'failed',$3,$4)`, [uuid(), orderId, provider, uuid()]);
    await webhook('settled', provider);
    await expectExpired([pendingRecord, settledRecord]);
  });
});
