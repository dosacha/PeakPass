import { PoolClient } from 'pg';
import { AppError, NotFoundError } from '@/core/errors';

// Two-int namespaces are disjoint from checkout's existing bigint advisory keys.
const EVENT_GATE = 1347436869;
const CLAIM_GATE = 1347436867;

export interface AdmissionPolicy {
  eventId: string;
  protected: boolean;
  generation: string;
  epoch: string;
  phase: 'recovering' | 'open';
  epochStartedAt: Date;
  redisNamespace: string;
}
export const policyColumns = `event_id AS "eventId", protected, generation::text,
  epoch::text, phase, epoch_started_at AS "epochStartedAt", redis_namespace AS "redisNamespace"`;

/** Caller owns the transaction. Read before any savepoint; retain locks through COMMIT. */
export async function readAdmissionPolicy(
  client: PoolClient,
  eventId: string,
  mode: 'shared' | 'exclusive' = 'shared',
): Promise<AdmissionPolicy> {
  await client.query(
    `SELECT ${mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'}($1::int,hashtext($2))`,
    [EVENT_GATE, eventId],
  );
  if (!(await client.query('SELECT id FROM events WHERE id=$1', [eventId])).rowCount) {
    throw new NotFoundError('Event', eventId);
  }
  await client.query(
    `INSERT INTO admission_events(event_id,redis_namespace)
    VALUES($1::uuid,'peakpass:admission:' || $1::uuid::text || ':') ON CONFLICT DO NOTHING`,
    [eventId],
  );
  const result = await client.query<AdmissionPolicy>(
    `SELECT ${policyColumns} FROM admission_events
    WHERE event_id=$1 FOR ${mode === 'shared' ? 'SHARE' : 'UPDATE'}`,
    [eventId],
  );
  if (!result.rows[0])
    throw new AppError('ADMISSION_UNAVAILABLE', 503, 'Admission policy unavailable');
  return result.rows[0];
}

export async function lockAdmission(
  client: PoolClient,
  admissionId: string,
  tryOnly = false,
): Promise<boolean> {
  const result = await client.query(
    `SELECT ${tryOnly ? 'pg_try_advisory_xact_lock' : 'pg_advisory_xact_lock'}($1::int,hashtext($2)) AS locked`,
    [CLAIM_GATE, admissionId],
  );
  return !tryOnly || result.rows[0].locked === true;
}

export function isAdmissionPolicyEventRace(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === '23503' && e.constraint === 'admission_events_event_id_fkey';
}
