import 'dotenv/config';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import {
  initPostgresPool,
  closePostgresPool,
  serializableTransactionWithRetry,
} from '@/infra/postgres/client';
import { initLogger } from '@/infra/logger';
import { readAdmissionPolicy } from '@/infra/postgres/admission-policy';
import { blocked } from './order-sweeper-fixture';

describe('admission-v1 on owned PostgreSQL and Redis', () => {
  let pool: Awaited<ReturnType<typeof initPostgresPool>>;
  const eventId = randomUUID();
  beforeAll(async () => {
    initLogger();
    pool = await initPostgresPool();
    await pool.query(
      `INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats)
      VALUES($1,'p4 fixture',NOW(),NOW()+interval '1 day',10,10)`,
      [eventId],
    );
  });
  afterAll(async () => {
    await pool
      .query('DELETE FROM admission_events WHERE event_id=$1', [eventId])
      .catch(() => undefined);
    await pool.query('DELETE FROM events WHERE id=$1', [eventId]);
    await closePostgresPool();
  });

  it('backfills existing events, constrains policy and lazily ensures later events', async () => {
    const file = 'src/infra/migrations/012_admission_events.sql';
    expect(existsSync(file)).toBe(true);
    const c = await pool.connect();
    await c.query('BEGIN');
    try {
      await c.query('DROP TABLE IF EXISTS admission_events');
      await c.query(readFileSync(file, 'utf8'));
      expect(
        (
          await c.query(
            'SELECT protected,generation::text FROM admission_events WHERE event_id=$1',
            [eventId],
          )
        ).rows,
      ).toEqual([{ protected: false, generation: '0' }]);
      const modulePath = '@/infra/postgres/admission-policy';
      const policy = await import(modulePath);
      await c.query('DELETE FROM admission_events WHERE event_id=$1', [eventId]);
      expect(await policy.readAdmissionPolicy(c, eventId, 'shared')).toMatchObject({
        eventId,
        protected: false,
        generation: '0',
        phase: 'recovering',
      });
      await expect(policy.readAdmissionPolicy(c, randomUUID(), 'shared')).rejects.toMatchObject({
        statusCode: 404,
      });
      const second = randomUUID();
      await c.query(
        `INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats)
      VALUES($1,'p4 second',NOW(),NOW()+interval '1 day',10,10)`,
        [second],
      );
      await policy.readAdmissionPolicy(c, second, 'exclusive');
      await c.query('UPDATE admission_events SET protected=true WHERE event_id=$1', [eventId]);
      for (const [sql, id, code] of [
        ['UPDATE admission_events SET protected=true WHERE event_id=$1', second, '23505'],
        ['UPDATE admission_events SET generation=-1 WHERE event_id=$1', eventId, '23514'],
        ["UPDATE admission_events SET phase='invalid' WHERE event_id=$1", eventId, '23514'],
      ]) {
        await c.query('SAVEPOINT constraint_check');
        await expect(c.query(sql, [id])).rejects.toMatchObject({ code });
        await c.query('ROLLBACK TO constraint_check');
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
  it.each([false, true])(
    'retries a stale SERIALIZABLE snapshot after activation (missing policy=%s)',
    async (missing) => {
      await serializableTransactionWithRetry((c) => readAdmissionPolicy(c, eventId));
      if (missing) await pool.query('DELETE FROM admission_events WHERE event_id=$1', [eventId]);
      const activation = await pool.connect();
      let consumer: Promise<unknown> | undefined;
      const transactions: string[] = [];
      try {
        await activation.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const pid = (await activation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await readAdmissionPolicy(activation, eventId, 'exclusive');
        await activation.query('UPDATE admission_events SET protected=true WHERE event_id=$1', [
          eventId,
        ]);
        consumer = serializableTransactionWithRetry(async (c) => {
          transactions.push((await c.query('SELECT txid_current()::text AS id')).rows[0].id);
          return readAdmissionPolicy(c, eventId, 'shared');
        });
        await blocked(pool, pid);
        await activation.query('COMMIT');
        expect(await consumer).toMatchObject({ eventId, protected: true });
        expect(transactions.length).toBeGreaterThan(1);
        expect(new Set(transactions).size).toBe(transactions.length);
        process.stdout.write(
          JSON.stringify({ admissionPolicyRetry: { missing, transactions } }) + '\n',
        );
      } finally {
        await activation.query('ROLLBACK');
        activation.release();
        await consumer?.catch(() => undefined);
        await pool.query('UPDATE admission_events SET protected=false WHERE event_id=$1', [
          eventId,
        ]);
      }
    },
  );
});
