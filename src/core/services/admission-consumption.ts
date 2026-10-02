import { PoolClient } from 'pg';
import { AppError } from '../errors';
import {
  AdmissionClaim,
  AdmissionError,
  AdmissionOutcome,
  AdmissionRef,
} from '../models/admission';
import { admissionService } from './admission.service';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';
import {
  isRetriableTransactionError,
  serializableTransactionWithRetry,
  transaction,
} from '@/infra/postgres/client';
import {
  AdmissionPolicy,
  isAdmissionPolicyEventRace,
  lockAdmission,
  readAdmissionPolicy,
} from '@/infra/postgres/admission-policy';
import { RedisAdmissionEntry } from '@/infra/redis/admission';

/**
 * admission-v1 §5: durable consumption shared by the two new seat-acquisition paths.
 *
 * PostgreSQL decides. `admission_results` is written in the same transaction as the reservation
 * or order, on the caller's PoolClient; Redis only approves the claim and is told the result
 * after COMMIT. Lock order: event gate → policy → admission → checkout key → existing rows.
 */
export type AdmissionOperation = 'reservation' | 'direct-checkout';

/** One logical purchase request. UUIDs are canonical lowercase; a reservation has no checkout key. */
export interface PurchaseCommand {
  operation: AdmissionOperation;
  userId: string;
  eventId: string;
  tierId: string;
  quantity: number;
  checkoutKey: string | null;
  admission?: AdmissionRef;
}
export function purchaseCommand(
  operation: AdmissionOperation,
  input: { userId: string; eventId: string; tierId: string; quantity: number },
  checkoutKey: string | null,
  admission?: AdmissionRef,
): PurchaseCommand {
  return {
    operation,
    userId: input.userId.toLowerCase(),
    eventId: input.eventId.toLowerCase(),
    tierId: input.tierId,
    quantity: input.quantity,
    checkoutKey: checkoutKey === null ? null : checkoutKey.trim().toLowerCase(),
    admission,
  };
}

/** The contract's canonical array. The admission ID is bound separately, as the ledger key. */
export const admissionFingerprint = (command: PurchaseCommand): string =>
  JSON.stringify([
    command.userId,
    command.eventId,
    command.admission!.epoch,
    command.operation,
    command.tierId,
    command.quantity,
    command.checkoutKey,
  ]);

export interface AdmissionResult {
  admissionId: string;
  userId: string;
  eventId: string;
  epoch: string;
  operation: AdmissionOperation;
  fingerprint: string;
  outcome: 'consumed' | 'rejected' | 'closed';
  reservationId: string | null;
  orderId: string | null;
  errorCode: string | null;
  httpStatus: number | null;
  errorMessage: string | null;
}
const resultColumns = `admission_id AS "admissionId", user_id AS "userId", event_id AS "eventId",
  epoch::text, operation, fingerprint, outcome, reservation_id AS "reservationId",
  order_id AS "orderId", error_code AS "errorCode", http_status AS "httpStatus",
  error_message AS "errorMessage"`;
const readResult = async (client: PoolClient, admissionId: string) =>
  (
    await client.query<AdmissionResult>(
      `SELECT ${resultColumns} FROM admission_results WHERE admission_id = $1`,
      [admissionId],
    )
  ).rows[0] ?? null;

/** The stored business rejection of a request, replayed with its original code, status and text. */
export const storedRejection = (result: AdmissionResult): AppError =>
  new AppError(result.errorCode!, result.httpStatus!, result.errorMessage!);

// Contract §5: bounds for a transaction that consumes or reclaims an admission.
const TIMEOUTS = `SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '1s';
  SET LOCAL idle_in_transaction_session_timeout = '10s'`;

export interface AdmissionGate {
  policy: AdmissionPolicy;
  /** The committed consumed or rejected result of the submitted admission for this same request. */
  prior: AdmissionResult | null;
}

/**
 * Steps 2–3: shared event gate, policy locking read, admission lock, durable result.
 * Nothing here looks at Redis, the epoch or the feature flag, so a committed result is recovered
 * whatever happened to the queue since. A result of another owner or event answers 404, a
 * different request 409, a closed admission its stored 410.
 */
export async function openAdmissionGate(
  client: PoolClient,
  command: PurchaseCommand,
): Promise<AdmissionGate> {
  const policy = await readAdmissionPolicy(client, command.eventId);
  const admission = command.admission;
  if (!admission) return { policy, prior: null };
  if (policy.protected) await client.query(TIMEOUTS);
  try {
    await lockAdmission(client, admission.admissionId);
  } catch (error) {
    // lock_timeout: another request for this admission is still inside its transaction.
    if ((error as { code?: string }).code === '55P03')
      throw new AdmissionError('ADMISSION_IN_PROGRESS', 409);
    throw error;
  }
  const prior = await readResult(client, admission.admissionId);
  if (!prior) return { policy, prior };
  if (prior.userId !== command.userId || prior.eventId !== command.eventId)
    throw new AdmissionError('ADMISSION_NOT_FOUND', 404);
  if (prior.fingerprint !== admissionFingerprint(command))
    throw new AdmissionError('ADMISSION_REQUEST_MISMATCH', 409);
  if (prior.outcome === 'closed') throw new AdmissionError(prior.errorCode!, prior.httpStatus!);
  return { policy, prior };
}

/**
 * An existing reservation or order is exempt from admission, whatever its TTL or epoch became.
 * Admission fields submitted with it must equal its durable link; a target that has no link
 * (created before rollout or while unprotected) stays unbound and the fields are ignored.
 */
export async function assertAdmissionLink(
  client: PoolClient,
  admission: AdmissionRef | undefined,
  orderId: string | null,
  reservationId: string | null,
): Promise<void> {
  if (!admission) return;
  const link = (
    await client.query<{ admissionId: string; epoch: string }>(
      `SELECT admission_id AS "admissionId", epoch::text FROM admission_results
      WHERE order_id = $1 OR reservation_id = $2`,
      [orderId, reservationId],
    )
  ).rows[0];
  if (link && (link.admissionId !== admission.admissionId || link.epoch !== admission.epoch))
    throw new AdmissionError('ADMISSION_REQUEST_MISMATCH', 409);
}

/** What the transaction owner tells Redis after COMMIT. */
export interface AdmissionSettlement {
  claim: AdmissionClaim;
  outcome: AdmissionOutcome;
}
export type Occupation<T> =
  | { value: T; settlement?: AdmissionSettlement }
  | { rejected: AppError; settlement?: AdmissionSettlement };

/**
 * Steps 4–5, only when a new occupation remains. `occupy` is the existing reservation or order
 * creation on the same client. On a protected event it runs inside a savepoint after the Redis
 * claim, and the ledger row commits with it. An unprotected event keeps the existing flow.
 */
export async function occupyThroughAdmission<T>(
  client: PoolClient,
  gate: AdmissionGate,
  command: PurchaseCommand,
  occupy: () => Promise<{ value: T; targetId: string }>,
): Promise<Occupation<T>> {
  const { policy } = gate;
  if (!policy.protected) return { value: (await occupy()).value };
  const admission = command.admission;
  // tier_id is VARCHAR(50); the fingerprint is stored in Redis, so a longer value never claims.
  if (!admission || command.tierId.length > 50)
    throw new AdmissionError('ADMISSION_INVALID_INPUT', 400);
  // An instance with the feature off never opens a protected event; ENV is not a release.
  if (!getConfig().ENABLE_ADMISSION) throw new AdmissionError('ADMISSION_UNAVAILABLE', 503, 1000);
  if (policy.phase !== 'open') throw new AdmissionError('ADMISSION_RECOVERING', 503, 1000);
  if (policy.epoch !== admission.epoch) throw new AdmissionError('ADMISSION_RESET', 410);
  // The ledger references the user: a subject without a row could claim but never be closed.
  if (!(await client.query('SELECT 1 FROM users WHERE id = $1', [command.userId])).rowCount)
    throw new AdmissionError('UNAUTHENTICATED', 401);

  const fingerprint = admissionFingerprint(command);
  const claim = await admissionService.claim({
    eventId: command.eventId,
    userId: command.userId,
    admissionId: admission.admissionId,
    epoch: admission.epoch,
    fingerprint,
  });
  await client.query('SAVEPOINT admission_occupation');
  let occupied: { value: T; targetId: string };
  try {
    occupied = await occupy();
  } catch (error) {
    // Only a confirmed business rejection is durable. A PostgreSQL error or a 5xx rolls the whole
    // transaction back and leaves the claim for the same request to resume.
    if (!(error instanceof AppError) || error.statusCode >= 500) throw error;
    await client.query('ROLLBACK TO SAVEPOINT admission_occupation');
    await client.query(
      `INSERT INTO admission_results
        (admission_id, user_id, event_id, epoch, operation, fingerprint, outcome,
         error_code, http_status, error_message)
      VALUES ($1, $2, $3, $4, $5, $6, 'rejected', $7, $8, $9)`,
      [
        admission.admissionId,
        command.userId,
        command.eventId,
        admission.epoch,
        command.operation,
        fingerprint,
        error.code,
        error.statusCode,
        error.message,
      ],
    );
    return {
      rejected: error,
      settlement: { claim, outcome: { kind: 'rejected', resourceId: null, code: error.code } },
    };
  }
  // The target must be the row this transaction created for exactly this request.
  const [target, table, direct] =
    command.operation === 'reservation'
      ? ['reservation_id', 'reservations', '']
      : ['order_id', 'orders', 'AND t.reservation_id IS NULL AND t.idempotency_key = $10::uuid'];
  const inserted = await client.query(
    `INSERT INTO admission_results
      (admission_id, user_id, event_id, epoch, operation, fingerprint, outcome, ${target})
    SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text, 'consumed', t.id
    FROM ${table} t
    WHERE t.id = $7::uuid AND t.user_id = $2::uuid AND t.event_id = $3::uuid
      AND t.tier_id = $8 AND t.quantity = $9 ${direct}`,
    [
      admission.admissionId,
      command.userId,
      command.eventId,
      admission.epoch,
      command.operation,
      fingerprint,
      occupied.targetId,
      command.tierId,
      command.quantity,
      ...(direct ? [command.checkoutKey] : []),
    ],
  );
  if (inserted.rowCount !== 1)
    throw new Error('Admission result target does not match its request');
  return {
    value: occupied.value,
    settlement: {
      claim,
      outcome: { kind: command.operation, resourceId: occupied.targetId, code: null },
    },
  };
}

/** A concurrent transaction committed this admission's result after our snapshot was taken. */
export function isAdmissionResultRace(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === 'admission_results_pkey';
}
// A fresh transaction resolves each of these: the committed result becomes visible (also when
// Redis reports it first, before our INSERT is reached), or the deleted event answers 404.
const isPurchaseRace = (error: unknown) =>
  isAdmissionResultRace(error) ||
  isAdmissionPolicyEventRace(error) ||
  (error instanceof AdmissionError && error.code === 'ADMISSION_ALREADY_CONSUMED');

// What a retry of the same request can outlive: serialization failure and deadlock once the
// attempts are used up, the races above, this transaction's own lock, statement and idle bounds,
// and a lost connection. Anything else (data, integrity, programming error) is a defect.
function isTransient(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  return (
    isRetriableTransactionError(error) ||
    isPurchaseRace(error) ||
    ['55P03', '57014', '25P03'].includes(code) ||
    /^(08|57P|E[A-Z]+$)/.test(code)
  );
}

/**
 * Runs one purchase transaction: SERIALIZABLE with the existing three attempts and backoff.
 * `readCommitted` keeps a reservation without admission fields on its existing isolation level.
 * With an admission, a transient failure that outlasts the attempts is 503 and the request keeps
 * its identity; a defect stays the existing 500.
 */
export async function purchaseTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
  options: { admission?: AdmissionRef; readCommitted?: boolean } = {},
): Promise<T> {
  try {
    if (!options.readCommitted)
      return await serializableTransactionWithRetry(work, { retryIf: isPurchaseRace });
    try {
      return await transaction(work);
    } catch (error) {
      if (!isAdmissionPolicyEventRace(error)) throw error;
      return await transaction(work);
    }
  } catch (error) {
    if (!options.admission || error instanceof AppError || !isTransient(error)) throw error;
    getLogger().warn(
      { err: error, admissionId: options.admission.admissionId },
      'Admission purchase failed transiently; the same request may be retried',
    );
    throw new AdmissionError('ADMISSION_UNAVAILABLE', 503, 1000);
  }
}

/** After COMMIT only. A Redis failure never undoes the result; the reclaimer finalizes it later. */
export async function settleAdmission(settlement?: AdmissionSettlement): Promise<void> {
  if (!settlement) return;
  try {
    await admissionService.complete(settlement.claim, settlement.outcome);
  } catch (err) {
    getLogger().warn(
      { err, admissionId: settlement.claim.admissionId },
      'Admission result is committed; Redis finalization is left to the reclaimer',
    );
  }
}

/**
 * Claims past their deadline (contract §5), as `reconcile` returned them to the scheduler tick.
 * Per claim: shared event gate → admission try-lock → ledger read after the lock. A committed
 * result is reflected to Redis. With no result, `closed` commits first and only then is the slot
 * returned, so a consumer that resumes later reads `closed` under the same lock.
 *
 * A held lock, a newer epoch or any error leaves the slot in use for the next tick: a missing
 * row, an expired deadline or a finally block is never authority to return it.
 */
export async function reclaimOverdueClaims(
  eventId: string,
  claims: RedisAdmissionEntry[],
): Promise<void> {
  for (const entry of claims) {
    try {
      // READ COMMITTED on purpose: the ledger is read after the lock, not from an older snapshot.
      const result = await transaction(async (client) => {
        await client.query(TIMEOUTS);
        const policy = await readAdmissionPolicy(client, eventId);
        // Under another epoch the barrier already keeps this claim from committing anything.
        if (!policy.protected || policy.epoch !== entry.epoch) return null;
        if (!(await lockAdmission(client, entry.admissionId, true))) return null;
        const committed = await readResult(client, entry.admissionId);
        if (committed) return committed;
        const closed = await client.query<AdmissionResult>(
          `INSERT INTO admission_results
            (admission_id, user_id, event_id, epoch, operation, fingerprint, outcome,
             error_code, http_status, error_message)
          VALUES ($1, $2, $3, $4, $5, $6, 'closed', 'ADMISSION_EXPIRED', 410, 'ADMISSION_EXPIRED')
          RETURNING ${resultColumns}`,
          [
            entry.admissionId,
            entry.userId,
            eventId,
            entry.epoch,
            // The claim's fingerprint is the canonical array; its fourth element is the operation.
            JSON.parse(entry.fingerprint!)[3],
            entry.fingerprint,
          ],
        );
        return closed.rows[0];
      });
      if (!result) continue;
      const claim: AdmissionClaim = {
        eventId,
        userId: entry.userId,
        admissionId: entry.admissionId,
        epoch: entry.epoch,
        fingerprint: entry.fingerprint!,
        claimToken: entry.claimToken!,
        deadline: entry.deadline!,
      };
      if (result.outcome === 'closed') await admissionService.close(claim);
      else if (result.outcome === 'rejected')
        await admissionService.complete(claim, {
          kind: 'rejected',
          resourceId: null,
          code: result.errorCode,
        });
      else
        await admissionService.complete(claim, {
          kind: result.operation,
          resourceId: result.reservationId ?? result.orderId,
          code: null,
        });
    } catch (err) {
      getLogger().warn(
        { err, eventId, admissionId: entry.admissionId },
        'Admission claim was not reclaimed; its slot stays in use until the next tick',
      );
    }
  }
}
