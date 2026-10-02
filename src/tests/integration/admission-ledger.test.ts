import 'dotenv/config';
import { randomUUID } from 'crypto';
import {
  initPostgresPool,
  closePostgresPool,
  serializableTransactionWithRetry,
} from '@/infra/postgres/client';
import { initLogger } from '@/infra/logger';

describe('admission_results ledger constraints on owned PostgreSQL (migration 013)', () => {
  let pool: Awaited<ReturnType<typeof initPostgresPool>>;
  const userId = randomUUID(),
    eventId = randomUUID(),
    epoch = randomUUID(),
    reservationId = randomUUID(),
    orderId = randomUUID();
  type Row = {
    admissionId: string;
    operation: string;
    outcome: string;
    reservationId: string | null;
    orderId: string | null;
    errorCode: string | null;
    httpStatus: number | null;
    errorMessage: string | null;
  };
  const row = (changes: Partial<Row> = {}): Row => ({
    admissionId: randomUUID(),
    operation: 'reservation',
    outcome: 'rejected',
    reservationId: null,
    orderId: null,
    errorCode: 'INSUFFICIENT_INVENTORY',
    httpStatus: 409,
    errorMessage: 'Insufficient inventory',
    ...changes,
  });
  const consumed = { errorCode: null, httpStatus: null, errorMessage: null, outcome: 'consumed' };
  const insert = (r: Row) =>
    pool.query(
      `INSERT INTO admission_results(admission_id,user_id,event_id,epoch,operation,fingerprint,
        outcome,reservation_id,order_id,error_code,http_status,error_message)
      VALUES($1,$2,$3,$4,$5,'[]',$6,$7,$8,$9,$10,$11)`,
      [
        r.admissionId,
        userId,
        eventId,
        epoch,
        r.operation,
        r.outcome,
        r.reservationId,
        r.orderId,
        r.errorCode,
        r.httpStatus,
        r.errorMessage,
      ],
    );
  beforeAll(async () => {
    initLogger();
    pool = await initPostgresPool();
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [
      userId,
      `${userId}@ledger.test`,
    ]);
    await pool.query(
      `INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats,status)
      VALUES($1,'p5 ledger',NOW(),NOW()+interval '1 day',10,10,'published')`,
      [eventId],
    );
    await pool.query(
      `INSERT INTO reservations(id,user_id,event_id,quantity,tier_id,expires_at)
      VALUES($1,$2,$3,1,'general',NOW()+interval '5 minutes')`,
      [reservationId, userId, eventId],
    );
    await pool.query(
      `INSERT INTO orders(id,user_id,event_id,quantity,tier_id,unit_price,total_amount,idempotency_key)
      VALUES($1,$2,$3,1,'general',10,10,$4)`,
      [orderId, userId, eventId, randomUUID()],
    );
  });
  afterEach(async () => {
    await pool.query('DELETE FROM admission_results WHERE event_id=$1', [eventId]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM orders WHERE id=$1', [orderId]);
    await pool.query('DELETE FROM reservations WHERE id=$1', [reservationId]);
    await pool.query('DELETE FROM events WHERE id=$1', [eventId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    await closePostgresPool();
  });

  it('accepts exactly the consumed, rejected and closed shapes of the contract', async () => {
    await insert(row({ ...consumed, reservationId }));
    await insert(row({ ...consumed, operation: 'direct-checkout', orderId }));
    await insert(row());
    await insert(
      row({
        operation: 'direct-checkout',
        outcome: 'closed',
        errorCode: 'ADMISSION_EXPIRED',
        httpStatus: 410,
        errorMessage: 'ADMISSION_EXPIRED',
      }),
    );
    const stored = await pool.query(
      'SELECT outcome,created_at FROM admission_results WHERE event_id=$1 ORDER BY outcome',
      [eventId],
    );
    expect(stored.rows.map((r) => r.outcome)).toEqual([
      'closed',
      'consumed',
      'consumed',
      'rejected',
    ]);
    expect(stored.rows.every((r) => r.created_at instanceof Date)).toBe(true);
  });
  it.each<[string, Partial<Row>]>([
    ['consumed without a target', { ...consumed }],
    ['consumed reservation pointing at an order', { ...consumed, orderId }],
    [
      'consumed direct checkout pointing at a reservation',
      { ...consumed, operation: 'direct-checkout', reservationId },
    ],
    ['consumed with both targets', { ...consumed, reservationId, orderId }],
    ['consumed carrying an error', { ...consumed, reservationId, errorCode: 'CONFLICT' }],
    ['rejected with a target', { reservationId }],
    ['rejected without an error code', { errorCode: null }],
    ['rejected without an HTTP status', { httpStatus: null }],
    ['rejected without a message', { errorMessage: null }],
    ['rejected with a server error status', { httpStatus: 500 }],
    ['closed with a target', { outcome: 'closed', operation: 'direct-checkout', orderId }],
    ['an unknown operation', { operation: 'refund' }],
    ['an unknown outcome', { outcome: 'pending' }],
  ])('rejects %s', async (_name, changes) => {
    await expect(insert(row(changes))).rejects.toMatchObject({ code: '23514' });
  });
  it('allows one result per admission, per reservation and per order', async () => {
    const first = row({ ...consumed, reservationId });
    await insert(first);
    await expect(insert(row({ admissionId: first.admissionId }))).rejects.toMatchObject({
      code: '23505',
      constraint: 'admission_results_pkey',
    });
    await expect(insert(row({ ...consumed, reservationId }))).rejects.toMatchObject({
      code: '23505',
      constraint: 'admission_results_reservation_id_key',
    });
    await insert(row({ ...consumed, operation: 'direct-checkout', orderId }));
    await expect(
      insert(row({ ...consumed, operation: 'direct-checkout', orderId })),
    ).rejects.toMatchObject({ code: '23505', constraint: 'admission_results_order_id_key' });
  });
  it('reruns a fresh transaction for a ledger key race and for no other unique violation', async () => {
    const { isAdmissionResultRace } = await import('@/core/services/admission-consumption');
    const existing = row();
    await insert(existing);
    const transactions: string[] = [];
    const duplicate = (c: import('pg').PoolClient, r: Row) =>
      c.query(
        `INSERT INTO admission_results(admission_id,user_id,event_id,epoch,operation,fingerprint,
          outcome,reservation_id) VALUES($1,$2,$3,$4,$5,'[]','consumed',$6)`,
        [r.admissionId, userId, eventId, epoch, r.operation, r.reservationId],
      );
    // Real 23505 on admission_results_pkey in the first transaction; the second reads the result.
    const outcome = await serializableTransactionWithRetry(
      async (c) => {
        transactions.push((await c.query('SELECT txid_current()::text AS id')).rows[0].id);
        if (transactions.length === 1)
          await duplicate(c, row({ admissionId: existing.admissionId, reservationId }));
        const found = await c.query('SELECT outcome FROM admission_results WHERE admission_id=$1', [
          existing.admissionId,
        ]);
        return found.rows[0].outcome;
      },
      { retryIf: isAdmissionResultRace },
    );
    expect(outcome).toBe('rejected');
    expect(new Set(transactions).size).toBe(2);
    await insert(row({ ...consumed, reservationId }));
    let attempts = 0;
    await expect(
      serializableTransactionWithRetry(
        async (c) => {
          attempts++;
          await duplicate(c, row({ reservationId }));
        },
        { retryIf: isAdmissionResultRace },
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'admission_results_reservation_id_key' });
    expect(attempts).toBe(1);
  });
  it('keeps every referenced user, event, reservation and order from being deleted', async () => {
    await insert(row({ ...consumed, reservationId }));
    await insert(row({ ...consumed, operation: 'direct-checkout', orderId }));
    // A user and an event that nothing but a rejected result references: only the ledger's own
    // foreign keys can refuse these two deletes.
    const loneUser = randomUUID(),
      loneEvent = randomUUID();
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [
      loneUser,
      `${loneUser}@ledger.test`,
    ]);
    await pool.query(
      `INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats)
      VALUES($1,'p5 ledger lone',NOW(),NOW()+interval '1 day',1,1)`,
      [loneEvent],
    );
    await pool.query(
      `INSERT INTO admission_results(admission_id,user_id,event_id,epoch,operation,fingerprint,
        outcome,error_code,http_status,error_message)
      VALUES($1,$2,$3,$4,'reservation','[]','rejected','CONFLICT',409,'conflict')`,
      [randomUUID(), loneUser, loneEvent, epoch],
    );
    try {
      for (const [table, id, constraint] of [
        ['reservations', reservationId, 'admission_results_reservation_id_fkey'],
        ['orders', orderId, 'admission_results_order_id_fkey'],
        ['events', loneEvent, 'admission_results_event_id_fkey'],
        ['users', loneUser, 'admission_results_user_id_fkey'],
      ]) {
        await expect(pool.query(`DELETE FROM ${table} WHERE id=$1`, [id])).rejects.toMatchObject({
          code: '23503',
          constraint,
        });
      }
    } finally {
      await pool.query('DELETE FROM admission_results WHERE event_id=$1', [loneEvent]);
      await pool.query('DELETE FROM events WHERE id=$1', [loneEvent]);
      await pool.query('DELETE FROM users WHERE id=$1', [loneUser]);
    }
  });
  it('rejects UPDATE of a committed result and still allows owned cleanup by DELETE', async () => {
    const result = row();
    await insert(result);
    for (const change of ["outcome='closed'", "fingerprint='[1]'", "error_code='CONFLICT'"]) {
      await expect(
        pool.query(`UPDATE admission_results SET ${change} WHERE admission_id=$1`, [
          result.admissionId,
        ]),
      ).rejects.toMatchObject({ code: '23001' });
    }
    expect(
      (
        await pool.query(
          'SELECT outcome,fingerprint,error_code FROM admission_results WHERE admission_id=$1',
          [result.admissionId],
        )
      ).rows,
    ).toEqual([{ outcome: 'rejected', fingerprint: '[]', error_code: 'INSUFFICIENT_INVENTORY' }]);
    expect(
      (
        await pool.query('DELETE FROM admission_results WHERE admission_id=$1', [
          result.admissionId,
        ])
      ).rowCount,
    ).toBe(1);
  });
});
