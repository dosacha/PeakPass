import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';

// The final SQL of admission-v1 §8 is one statement that returns only violating rows. Each case
// below builds a state inside a transaction that is rolled back and reads the checks inside it.
const finalSql = () => readFileSync(join(__dirname, 'admission-final.sql'), 'utf8');
const EPOCH = '22222222-2222-4222-8222-222222222222';

interface Ids {
  event: string;
  user: string;
  other: string;
}

describe('final SQL of admission-v1 §8', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = await initPostgresPool();
  });
  afterAll(async () => {
    await closePostgresPool();
  });

  async function checks(build: (c: PoolClient, ids: Ids) => Promise<void>): Promise<string[]> {
    const c = await pool.connect();
    const ids = { event: randomUUID(), user: randomUUID(), other: randomUUID() };
    try {
      await c.query('BEGIN');
      await c.query('INSERT INTO users(id,email) VALUES($1,$2),($3,$4)', [
        ids.user,
        `${ids.user}@p7.test`,
        ids.other,
        `${ids.other}@p7.test`,
      ]);
      await c.query(
        `INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats,pricing,status)
        VALUES($1,'p7 final',NOW()+interval '1 hour',NOW()+interval '2 hours',10,10,$2,'published')`,
        [ids.event, JSON.stringify([{ id: 'general', name: 'General', price: 50, quantity: 10 }])],
      );
      await build(c, ids);
      const rows = (await c.query(finalSql())).rows as Array<{ check_name: string; event_id: string }>;
      return rows
        .filter((row) => row.event_id === ids.event)
        .map((row) => row.check_name)
        .sort();
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  const seats = (c: PoolClient, ids: Ids, available: number) =>
    c.query('UPDATE events SET available_seats=$2 WHERE id=$1', [ids.event, available]);
  async function reservation(c: PoolClient, ids: Ids, quantity: number, status = 'active') {
    const id = randomUUID();
    await c.query(
      `INSERT INTO reservations(id,user_id,event_id,quantity,tier_id,expires_at,status)
      VALUES($1,$2,$3,$4,'general',NOW()+interval '5 minutes',$5)`,
      [id, ids.user, ids.event, quantity, status],
    );
    return id;
  }
  // An order as checkout leaves it: with its pending payment record under the checkout key.
  async function order(
    c: PoolClient,
    ids: Ids,
    quantity: number,
    status = 'pending',
    reservationId: string | null = null,
    checkoutRecord = true,
  ) {
    const id = randomUUID(),
      key = randomUUID();
    await c.query(
      `INSERT INTO orders(id,user_id,event_id,quantity,tier_id,unit_price,total_amount,status,
        idempotency_key,reservation_id) VALUES($1,$2,$3,$4,'general',50,$5,$6,$7,$8)`,
      [id, ids.user, ids.event, quantity, 50 * quantity, status, key, reservationId],
    );
    if (checkoutRecord)
      await c.query(
        `INSERT INTO payment_records(id,order_id,status,idempotency_key) VALUES($1,$2,'pending',$3)`,
        [randomUUID(), id, key],
      );
    return { id, key };
  }
  // A settlement as the webhook leaves it: the provider record and the durable callback key.
  async function settlement(
    c: PoolClient,
    orderId: string,
    options: { reconciliation?: boolean; callbackKey?: boolean } = {},
  ) {
    const key = randomUUID(),
      provider = `provider-${randomUUID()}`;
    await c.query(
      `INSERT INTO payment_records(id,order_id,status,provider_transaction_id,idempotency_key,
        webhook_received_at,reconciliation_required) VALUES($1,$2,'settled',$3,$4,NOW(),$5)`,
      [randomUUID(), orderId, provider, key, options.reconciliation ?? false],
    );
    if (options.callbackKey ?? true)
      await c.query(
        `INSERT INTO payment_callback_keys(idempotency_key,order_id,provider_transaction_id,callback_status)
        VALUES($1,$2,$3,'settled')`,
        [key, orderId, provider],
      );
  }
  const tickets = async (
    c: PoolClient,
    ids: Ids,
    orderId: string,
    count: number,
    user = ids.user,
    status = 'active',
  ) => {
    for (let i = 0; i < count; i++)
      await c.query(
        `INSERT INTO tickets(id,order_id,event_id,user_id,ticket_number,status) VALUES($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), orderId, ids.event, user, `P7-${randomUUID()}`, status],
      );
  };
  async function paid(c: PoolClient, ids: Ids, quantity: number) {
    const created = await order(c, ids, quantity, 'paid');
    await settlement(c, created.id);
    await tickets(c, ids, created.id, quantity);
    return created;
  }
  async function protect(c: PoolClient, ids: Ids) {
    // One protected event per database: the others are released inside this transaction only.
    await c.query('UPDATE admission_events SET protected=false WHERE protected');
    await c.query(
      `INSERT INTO admission_events(event_id,protected,redis_namespace) VALUES($1,true,$2)`,
      [ids.event, `peakpass:admission:${ids.event}:`],
    );
  }
  const consumed = (
    c: PoolClient,
    ids: Ids,
    operation: 'reservation' | 'direct-checkout',
    targetId: string,
    fingerprint: unknown[],
  ) =>
    c.query(
      `INSERT INTO admission_results(admission_id,user_id,event_id,epoch,operation,fingerprint,outcome,
        reservation_id,order_id) VALUES($1,$2,$3,$4,$5,$6,'consumed',$7,$8)`,
      [
        randomUUID(),
        ids.user,
        ids.event,
        EPOCH,
        operation,
        JSON.stringify(fingerprint),
        operation === 'reservation' ? targetId : null,
        operation === 'reservation' ? null : targetId,
      ],
    );

  it('returns nothing for a consistent state and counts a converted reservation once', async () => {
    expect(
      await checks(async (c, ids) => {
        await protect(c, ids);
        const held = await reservation(c, ids, 2);
        await consumed(c, ids, 'reservation', held, [ids.user, ids.event, EPOCH, 'reservation', 'general', 2, null]);
        const converted = await reservation(c, ids, 3, 'converted');
        await consumed(c, ids, 'reservation', converted, [ids.user, ids.event, EPOCH, 'reservation', 'general', 3, null]);
        await order(c, ids, 3, 'pending', converted);
        const direct = await paid(c, ids, 1);
        await consumed(c, ids, 'direct-checkout', direct.id, [ids.user, ids.event, EPOCH, 'direct-checkout', 'general', 1, direct.key]);
        // An expired reservation holds no seat but keeps the result that created it.
        const expired = await reservation(c, ids, 4, 'expired');
        await consumed(c, ids, 'reservation', expired, [ids.user, ids.event, EPOCH, 'reservation', 'general', 4, null]);
        await seats(c, ids, 10 - 2 - 3 - 1);
      }),
    ).toEqual([]);
  });

  it('reports a seat count that does not add up, and a count outside its bounds', async () => {
    expect(await checks(async (c, ids) => void (await reservation(c, ids, 2)))).toEqual(['seat_equation']);
    expect(
      await checks(async (c, ids) => {
        await c.query('ALTER TABLE events DROP CONSTRAINT events_available_seats_not_above_total_check');
        await seats(c, ids, 11);
      }),
    ).toEqual(['seat_bounds', 'seat_equation']);
  });

  it('reports tickets that do not match their order', async () => {
    expect(
      await checks(async (c, ids) => {
        const created = await order(c, ids, 2, 'paid');
        await settlement(c, created.id);
        await tickets(c, ids, created.id, 1);
        await seats(c, ids, 8);
      }),
    ).toEqual(['ticket_count']);
    expect(
      await checks(async (c, ids) => {
        const created = await order(c, ids, 2);
        await tickets(c, ids, created.id, 2);
        await seats(c, ids, 8);
      }),
    ).toEqual(['ticket_count']);
    // A cancelled ticket is a ticket: the product cancels none, so it cannot make a count fit.
    expect(
      await checks(async (c, ids) => {
        const created = await paid(c, ids, 1);
        await tickets(c, ids, created.id, 1, ids.user, 'cancelled');
        await seats(c, ids, 9);
      }),
    ).toEqual(['ticket_count']);
    expect(
      await checks(async (c, ids) => {
        const created = await order(c, ids, 1);
        await tickets(c, ids, created.id, 1, ids.user, 'cancelled');
        await seats(c, ids, 9);
      }),
    ).toEqual(['ticket_count']);
    expect(
      await checks(async (c, ids) => {
        const created = await order(c, ids, 1, 'paid');
        await settlement(c, created.id);
        await tickets(c, ids, created.id, 1, ids.other);
        await seats(c, ids, 9);
      }),
    ).toEqual(['ticket_identity']);
  });

  it('reports a consumed result that does not match its target or its own fingerprint', async () => {
    expect(
      await checks(async (c, ids) => {
        const held = await reservation(c, ids, 2);
        await consumed(c, ids, 'reservation', held, [ids.user, ids.event, EPOCH, 'reservation', 'general', 3, null]);
        await seats(c, ids, 8);
      }),
    ).toEqual(['result_target']);
    expect(
      await checks(async (c, ids) => {
        const direct = await order(c, ids, 1);
        await consumed(c, ids, 'direct-checkout', direct.id, [ids.user, ids.event, EPOCH, 'direct-checkout', 'general', 1, randomUUID()]);
        await seats(c, ids, 9);
      }),
    ).toEqual(['result_target']);
    expect(
      await checks(async (c, ids) => {
        const held = await reservation(c, ids, 2);
        await consumed(c, ids, 'reservation', held, [ids.other, ids.event, EPOCH, 'reservation', 'general', 2, null]);
        await seats(c, ids, 8);
      }),
    ).toEqual(['result_fingerprint']);
  });

  it('reports an occupation of a protected event that no admission result stands for', async () => {
    const build = (isProtected: boolean) => async (c: PoolClient, ids: Ids) => {
      if (isProtected) await protect(c, ids);
      await reservation(c, ids, 2);
      await order(c, ids, 1);
      await seats(c, ids, 7);
    };
    expect(await checks(build(true))).toEqual(['unlinked_occupation', 'unlinked_occupation']);
    expect(await checks(build(false))).toEqual([]);
  });

  it('reports payment records that do not match the order or its callback key', async () => {
    expect(
      await checks(async (c, ids) => {
        const created = await order(c, ids, 1, 'paid');
        await tickets(c, ids, created.id, 1);
        await seats(c, ids, 9);
      }),
    ).toEqual(['payment_settled']);
    expect(
      await checks(async (c, ids) => {
        const created = await order(c, ids, 1);
        await settlement(c, created.id);
        await seats(c, ids, 9);
      }),
    ).toEqual(['payment_settled']);
    // A settlement that arrived after the order expired is a reconciliation fact, not a payment.
    expect(
      await checks(async (c, ids) => {
        const created = await order(c, ids, 1, 'expired');
        await settlement(c, created.id, { reconciliation: true });
      }),
    ).toEqual([]);
    expect(
      await checks(async (c, ids) => {
        const created = await order(c, ids, 1, 'paid');
        await settlement(c, created.id, { callbackKey: false });
        await tickets(c, ids, created.id, 1);
        await seats(c, ids, 9);
      }),
    ).toEqual(['payment_callback_key']);
    // The key carries the status of the callback that wrote the record. Only a reconciliation
    // fact may differ: a late success is written over the record of an earlier failure.
    expect(
      await checks(async (c, ids) => {
        const created = await paid(c, ids, 1);
        await c.query(`UPDATE payment_callback_keys SET callback_status = 'failed' WHERE order_id = $1`, [created.id]);
        await seats(c, ids, 9);
      }),
    ).toEqual(['payment_callback_key']);
    expect(
      await checks(async (c, ids) => {
        const created = await order(c, ids, 1, 'expired');
        await settlement(c, created.id, { reconciliation: true });
        await c.query(`UPDATE payment_callback_keys SET callback_status = 'failed' WHERE order_id = $1`, [created.id]);
      }),
    ).toEqual([]);
    expect(
      await checks(async (c, ids) => {
        await order(c, ids, 1, 'pending', null, false);
        await seats(c, ids, 9);
      }),
    ).toEqual(['payment_checkout_record']);
    // One checkout record per order: a second one under another key, or one that is no longer
    // pending, is not the record the checkout wrote.
    expect(
      await checks(async (c, ids) => {
        const created = await order(c, ids, 1);
        await c.query(`INSERT INTO payment_records(id,order_id,status,idempotency_key) VALUES($1,$2,'pending',$3)`, [
          randomUUID(),
          created.id,
          randomUUID(),
        ]);
        await seats(c, ids, 9);
      }),
    ).toEqual(['payment_checkout_record']);
    expect(
      await checks(async (c, ids) => {
        const created = await order(c, ids, 1);
        await c.query(`UPDATE payment_records SET status = 'failed' WHERE order_id = $1`, [created.id]);
        await seats(c, ids, 9);
      }),
    ).toEqual(['payment_checkout_record']);
    // The checkout record keeps the key as the client sent it; the order stores it as a UUID.
    expect(
      await checks(async (c, ids) => {
        const created = await order(c, ids, 1);
        await c.query('UPDATE payment_records SET idempotency_key = upper(idempotency_key) WHERE order_id = $1', [created.id]);
        await seats(c, ids, 9);
      }),
    ).toEqual([]);
  });
});
