import 'dotenv/config';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { once } from 'events';
import { initLogger } from '@/infra/logger';
import { initRedis, closeRedis } from '@/infra/redis/client';
import {
  initPostgresPool,
  closePostgresPool,
  serializableTransactionWithRetry,
} from '@/infra/postgres/client';
import { readAdmissionPolicy } from '@/infra/postgres/admission-policy';
import { AdmissionService } from '@/core/services/admission.service';
import { publishAdmission } from '@/infra/redis/admission';

jest.setTimeout(30000);
describe('admission actual process interruption and P4 startup guard', () => {
  let redis: Awaited<ReturnType<typeof initRedis>>,
    pool: Awaited<ReturnType<typeof initPostgresPool>>;
  let eventId: string;
  const service = new AdmissionService(true);
  beforeAll(async () => {
    initLogger();
    redis = await initRedis();
    pool = await initPostgresPool();
  });
  beforeEach(async () => {
    eventId = randomUUID();
    await pool.query(
      `INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats)
      VALUES($1,'p4 process',NOW(),NOW()+interval '1 day',10,10)`,
      [eventId],
    );
    await serializableTransactionWithRetry((c) => readAdmissionPolicy(c, eventId, 'exclusive'));
  });
  afterEach(async () => {
    await pool.query('DELETE FROM events WHERE id=$1', [eventId]);
    const keys = await redis.keys(`peakpass:admission:${eventId}:*`);
    if (keys.length) await redis.del(keys);
  });
  afterAll(async () => {
    await closeRedis();
    await closePostgresPool();
  });
  it.each(['frozen', 'barrier', 'initialized', 'open'])(
    'resumes after coordinator kill at %s without reopening a retired generation',
    async (stage) => {
      await pool.query('UPDATE admission_events SET protected=true WHERE event_id=$1', [eventId]);
      await service.verifyEnvironment();
      await service.recover(eventId);
      const before = (await service.control(eventId))!;
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/tests/integration/admission-recovery-fixture.ts', eventId, stage],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true },
      );
      try {
        expect((await once(child, 'message', { signal: AbortSignal.timeout(10000) }))[0]).toEqual({
          stage,
        });
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
        await service.recover(eventId);
        const after = (await service.control(eventId))!;
        expect(after.mode).toBe('ready');
        expect(BigInt(after.generation)).toBe(BigInt(before.generation) + 1n);
        expect((await publishAdmission(eventId, before.epoch, before.generation)).ok).toBe(false);
        expect((await service.status(eventId, randomUUID())).admission).toBeNull();
        process.stdout.write(
          JSON.stringify({
            admissionCrashRecovery: { stage, generation: after.generation, mode: after.mode },
          }) + '\n',
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      }
    },
  );
  async function startupFailure(enabled: boolean) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      windowsHide: true,
      env: { ...process.env, PORT: '0', LOG_LEVEL: 'error', ENABLE_ADMISSION: String(enabled) },
    });
    let output = '';
    child.stdout!.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr!.on('data', (chunk) => {
      output += String(chunk);
    });
    try {
      const [code] = await once(child, 'exit', { signal: AbortSignal.timeout(10000) });
      expect(code).toBe(1);
      return output;
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  }
  it.each([false, true])(
    'refuses protected product startup even with ENABLE_ADMISSION=%s',
    async (enabled) => {
      await pool.query('UPDATE admission_events SET protected=true WHERE event_id=$1', [eventId]);
      expect(await startupFailure(enabled)).toContain('P4 cannot serve a protected event');
    },
  );
  it('refuses readiness when the Redis environment violates the accepted volatile profile', async () => {
    await redis.configSet('maxmemory-policy', 'allkeys-lru');
    try {
      expect(await startupFailure(true)).toContain('ADMISSION_UNAVAILABLE');
    } finally {
      await redis.configSet('maxmemory-policy', 'noeviction');
    }
  });
});
