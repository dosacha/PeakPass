import { randomUUID } from 'crypto';
import { getConfig } from '@/infra/config';
import { getPostgresPool, serializableTransactionWithRetry } from '@/infra/postgres/client';
import {
  readAdmissionPolicy,
  policyColumns,
  AdmissionPolicy,
  isAdmissionPolicyEventRace,
} from '@/infra/postgres/admission-policy';
import { withRedis, getRedisConnectionVersion } from '@/infra/redis/client';
import {
  runAdmission,
  getAdmissionControl,
  initializeAdmission,
  publishAdmission,
  freezeAdmission,
  unlinkRetiredAdmission,
  AdmissionControl,
  RedisAdmissionResult,
  RedisAdmissionEntry,
} from '@/infra/redis/admission';
import {
  AdmissionError,
  AdmissionResponse,
  AdmissionSnapshot,
  ClaimIdentity,
  AdmissionClaim,
  AdmissionOutcome,
} from '../models/admission';

const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
function snapshot(entry: RedisAdmissionEntry): AdmissionSnapshot {
  return {
    admissionId: entry.admissionId,
    epoch: entry.epoch,
    state: entry.state,
    phase: entry.phase,
    sequence: entry.sequence,
    position: entry.position ?? null,
    joinedAt: iso(entry.joinedAt)!,
    admittedAt: iso(entry.admittedAt),
    expiresAt: iso(entry.expiresAt),
    reason: entry.reason,
    outcome: entry.outcome,
  };
}
function accepted(result: RedisAdmissionResult): RedisAdmissionResult {
  if (!result.ok)
    throw new AdmissionError(
      result.code ?? 'ADMISSION_UNAVAILABLE',
      result.status ?? 503,
      result.wait ?? null,
      result.code === 'ACTIVE_ADMISSION_EXISTS' && result.entry
        ? snapshot(result.entry)
        : undefined,
    );
  return result;
}

export class AdmissionService {
  private version = -1;
  private runId = '';
  private healthy = false;
  private stopping = false;
  private cleanupCursor = 0;
  constructor(private enabled = getConfig().ENABLE_ADMISSION) {}
  isReady(): boolean {
    return this.healthy && this.version === getRedisConnectionVersion();
  }
  stop(): void {
    this.stopping = true;
    this.healthy = false;
    this.version = -1;
  }
  control(eventId: string) {
    return getAdmissionControl(eventId);
  }
  freeze(eventId: string, observed: AdmissionControl) {
    return freezeAdmission(eventId, observed.epoch, observed.generation);
  }

  async verifyEnvironment(): Promise<void> {
    this.healthy = false;
    if (this.stopping) throw new AdmissionError('ADMISSION_UNAVAILABLE', 503, 1000);
    const data = await withRedis(async (r) => ({
      config: Object.assign(
        {},
        ...(await Promise.all(
          ['appendonly', 'save', 'maxmemory-policy'].map((key) => r.configGet(key)),
        )),
      ),
      info: await r.info('server'),
    }));
    if (
      data.config.appendonly !== 'no' ||
      data.config.save !== '' ||
      data.config['maxmemory-policy'] !== 'noeviction'
    ) {
      throw new AdmissionError('ADMISSION_UNAVAILABLE', 503, 1000);
    }
    const runId = /^run_id:(.+)\r?$/m.exec(data.info)?.[1].trim();
    if (!runId) throw new AdmissionError('ADMISSION_UNAVAILABLE', 503, 1000);
    if (this.stopping) throw new AdmissionError('ADMISSION_UNAVAILABLE', 503, 1000);
    this.runId = runId;
    this.version = getRedisConnectionVersion();
    this.healthy = true;
  }

  // The cold/error path classifies policy but NEVER creates/reset a Redis namespace.
  // Normal ready queue polling does not call this function or acquire a PG connection.
  private async unavailableEvent(eventId: string): Promise<never> {
    let policy: AdmissionPolicy;
    try {
      policy = await serializableTransactionWithRetry((c) => readAdmissionPolicy(c, eventId));
    } catch (error) {
      if (!isAdmissionPolicyEventRace(error)) throw error;
      policy = await serializableTransactionWithRetry((c) => readAdmissionPolicy(c, eventId));
    }
    throw new AdmissionError(
      policy.protected ? 'ADMISSION_RECOVERING' : 'ADMISSION_NOT_ENABLED',
      policy.protected ? 503 : 404,
      policy.protected ? 1000 : null,
    );
  }
  private async execute(
    eventId: string,
    operation: Parameters<typeof runAdmission>[2],
    input: Record<string, unknown>,
    epoch?: string,
  ) {
    try {
      const control = await this.control(eventId);
      if (!control) return await this.unavailableEvent(eventId);
      if (!this.enabled || !this.isReady() || control.runId !== this.runId)
        throw new AdmissionError('ADMISSION_RECOVERING', 503, 1000);
      const result = await runAdmission(eventId, epoch ?? control.epoch, operation, input);
      if (operation === 'status' && result.code === 'ADMISSION_RESET')
        throw new AdmissionError('ADMISSION_RECOVERING', 503, 1000);
      return accepted(result);
    } catch (error) {
      if (error instanceof AdmissionError) {
        if (error.statusCode === 503) this.healthy = false;
        throw error;
      }
      if ((error as { statusCode?: number }).statusCode === 404)
        throw new AdmissionError('ADMISSION_NOT_ENABLED', 404);
      this.healthy = false;
      throw new AdmissionError('ADMISSION_UNAVAILABLE', 503, 1000);
    }
  }
  private response(eventId: string, result: RedisAdmissionResult): AdmissionResponse {
    const entry = result.entry ? snapshot(result.entry) : null;
    const poll =
      entry?.state === 'waiting'
        ? entry.position! <= 10
          ? 1000
          : 5000
        : entry?.state === 'admitted'
          ? 1000
          : null;
    return {
      contractRevision: 'admission-v1',
      serverTime: iso(result.now)!,
      queue: { eventId, epoch: result.epoch, mode: 'open' },
      admission: entry,
      nextPollAfterMs: poll,
    };
  }
  async status(eventId: string, userId: string) {
    return this.response(eventId, await this.execute(eventId, 'status', { userId }));
  }
  async join(eventId: string, userId: string, epoch: string, joinRequestId: string) {
    const result = await this.execute(
      eventId,
      'join',
      { userId, joinRequestId, admissionId: randomUUID() },
      epoch,
    );
    return { created: result.created === true, body: this.response(eventId, result) };
  }
  async cancel(eventId: string, userId: string, epoch: string, admissionId: string) {
    return this.response(
      eventId,
      await this.execute(eventId, 'cancel', { userId, admissionId }, epoch),
    );
  }
  async promote(eventId: string) {
    return this.execute(eventId, 'tick', {});
  }
  /** P5 MUST hold the PG admission lock on the same transaction's PoolClient. */
  async claim(input: ClaimIdentity): Promise<AdmissionClaim> {
    const result = await this.execute(
      input.eventId,
      'claim',
      { ...input, claimToken: randomUUID() },
      input.epoch,
    );
    return { ...input, claimToken: result.entry!.claimToken!, deadline: result.entry!.deadline! };
  }
  /** Only after P5 has committed/verified a matching immutable durable result. */
  async complete(claim: AdmissionClaim, outcome: AdmissionOutcome) {
    return this.execute(claim.eventId, 'complete', { ...claim, outcome }, claim.epoch);
  }
  /** Only after P5's closed commit, never from a timeout/finally callback. */
  async close(claim: AdmissionClaim) {
    return this.execute(claim.eventId, 'close', { ...claim }, claim.epoch);
  }
  async reconcile(eventId: string) {
    return this.execute(eventId, 'reconcile', {});
  }

  /** Internal lifecycle. P4 exposes NO activation route or environment bypass. */
  async recover(eventId: string, observed?: AdmissionControl | null): Promise<void> {
    if (!this.isReady()) await this.verifyEnvironment();
    const old = observed === undefined ? await this.control(eventId).catch(() => null) : observed;
    // A healthy initializing namespace is an interrupted publication, not a new reset.
    if (old && old.mode !== 'initializing') await this.freeze(eventId, old).catch(() => undefined);
    const policy = await serializableTransactionWithRetry(async (c) => {
      const current = await readAdmissionPolicy(c, eventId, 'exclusive');
      if (!current.protected) return null;
      // An observer of an older loss follows the current recovery instead of incrementing again.
      const advanced =
        old && (current.generation !== old.generation || current.epoch !== old.epoch);
      // Re-read under the barrier: another observer of missing control may have recovered already.
      const probe = await runAdmission(eventId, current.epoch, 'probe', {
        generation: current.generation,
        runId: this.runId,
      });
      const resume = probe.ok && (advanced || !old || old.mode === 'initializing');
      const firstInitialization =
        current.phase === 'recovering' && probe.empty && (!old?.dirty || advanced);
      if (!resume && !firstInitialization) {
        await freezeAdmission(eventId, current.epoch, current.generation);
        return (
          await c.query<AdmissionPolicy>(
            `UPDATE admission_events SET generation=generation+1,epoch=$2,
          phase='recovering',epoch_started_at=clock_timestamp() WHERE event_id=$1 RETURNING ${policyColumns}`,
            [eventId, randomUUID()],
          )
        ).rows[0];
      }
      return current;
    });
    if (!policy) return;
    await serializableTransactionWithRetry(async (c) => {
      const current = await readAdmissionPolicy(c, eventId, 'exclusive');
      if (
        !current.protected ||
        current.generation !== policy.generation ||
        current.epoch !== policy.epoch
      )
        return;
      accepted(await initializeAdmission(current, this.runId));
      if (current.phase === 'recovering')
        await c.query("UPDATE admission_events SET phase='open' WHERE event_id=$1", [eventId]);
    });
    // Deliberately a new transaction. Holding the exclusive gate through CAS fences late publishers.
    await serializableTransactionWithRetry(async (c) => {
      const current = await readAdmissionPolicy(c, eventId, 'exclusive');
      if (
        !current.protected ||
        current.phase !== 'open' ||
        current.generation !== policy.generation ||
        current.epoch !== policy.epoch
      )
        return;
      accepted(await publishAdmission(eventId, current.epoch, current.generation));
    });
  }

  async maintain(stopped = () => false): Promise<void> {
    if (!this.enabled || stopped()) return;
    if (!this.isReady()) await this.verifyEnvironment();
    const policies = (
      await getPostgresPool().query<AdmissionPolicy>(
        `SELECT ${policyColumns} FROM admission_events WHERE protected`,
      )
    ).rows;
    for (const policy of policies) {
      if (stopped()) return;
      const control = await this.control(policy.eventId).catch(() => null);
      try {
        if (
          !control ||
          control.runId !== this.runId ||
          control.epoch !== policy.epoch ||
          control.mode !== 'ready' ||
          policy.phase !== 'open'
        ) {
          await this.recover(policy.eventId, control);
        } else {
          await this.promote(policy.eventId);
          // P4 can mark overdue claims, but only P5 can decide and commit durable closure.
          if (!stopped()) await this.reconcile(policy.eventId);
        }
      } catch (error) {
        if (stopped()) return;
        this.healthy = false;
        await this.verifyEnvironment();
        try {
          await this.recover(policy.eventId, control);
        } catch (recoveryError) {
          this.healthy = false;
          throw recoveryError;
        }
      }
      if (!stopped()) await this.cleanRetired(policy.eventId);
    }
  }
  private async cleanRetired(eventId: string) {
    const control = await this.control(eventId);
    if (!control || control.mode !== 'ready') return;
    const prefix = `peakpass:admission:${eventId}:`;
    const page = await withRedis((r) =>
      r.scan(this.cleanupCursor, { MATCH: prefix + '*', COUNT: 100 }),
    );
    this.cleanupCursor = page.cursor;
    // CAS and UNLINK share one command so a stale scan cannot delete a newly published epoch.
    await unlinkRetiredAdmission(eventId, control, page.keys);
  }
}
export const admissionService = new AdmissionService();

export async function assertP4AdmissionStartup(): Promise<void> {
  const result = await getPostgresPool().query(
    'SELECT event_id FROM admission_events WHERE protected LIMIT 1',
  );
  if (result.rowCount)
    throw new Error('P4 cannot serve a protected event before the P5 purchase gate is installed');
}
