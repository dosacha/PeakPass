import 'dotenv/config';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { once } from 'events';
import { createServer, AddressInfo } from 'net';
import { getConfig } from '@/infra/config';
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
import { until } from './order-sweeper-fixture';
import { purchaseFixture, setProtected, TIER, Json } from './admission-purchase-fixture';

jest.setTimeout(60000);
describe('admission actual process interruption and product startup', () => {
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
  // The product process itself, with its own scheduler when enabled. P5 replaced the P4 guard:
  // a protected policy no longer blocks startup because both purchase paths are gated.
  async function startProduct(enabled: boolean) {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(port),
        LOG_LEVEL: 'error',
        ENABLE_ADMISSION: String(enabled),
      },
    });
    let output = '';
    child.stdout!.on('data', (chunk) => (output += String(chunk)));
    child.stderr!.on('data', (chunk) => (output += String(chunk)));
    const base = `http://127.0.0.1:${port}`;
    const call = async (
      method: string,
      path: string,
      token?: string,
      body?: unknown,
      headers: object = {},
    ) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: token } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Json };
    };
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    };
    const ready = await until(async () => {
      if (child.exitCode !== null) throw new Error(`Product exited during startup: ${output}`);
      return call('GET', '/ready').then(
        (r) => r.status === 200 && r.body.checks.admission === true,
        () => false,
      );
    }, 30000);
    if (!ready) {
      await stop();
      throw new Error(`Product did not become ready: ${output}`);
    }
    return { call, stop };
  }
  // HTTP polling against the product stays far below its per-user status limit.
  const poll = async (check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  it('serves a protected event with the feature off: ready, 503 for a new occupation, 400 without admission', async () => {
    const fx = await purchaseFixture(pool, getConfig().JWT_SECRET);
    await setProtected(fx.eventId, true);
    let stop: (() => Promise<void>) | undefined;
    try {
      const product = await startProduct(false);
      stop = product.stop;
      const [user] = fx.users,
        token = fx.token(user),
        purchase = { eventId: fx.eventId, userId: user, tierId: TIER, quantity: 1 },
        admission = { admissionId: randomUUID(), admissionEpoch: randomUUID() },
        key = () => ({ 'idempotency-key': randomUUID() });
      for (const response of [
        await product.call('POST', '/reservations', token, { ...purchase, ...admission }),
        await product.call('POST', '/checkouts', token, { ...purchase, ...admission }, key()),
      ]) {
        expect(response.status).toBe(503);
        expect(response.body.error.code).toBe('ADMISSION_UNAVAILABLE');
      }
      for (const response of [
        await product.call('POST', '/reservations', token, purchase),
        await product.call('POST', '/checkouts', token, purchase, key()),
      ]) {
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('ADMISSION_INVALID_INPUT');
      }
      expect(await fx.state()).toMatchObject({
        available: 20,
        reservations: 0,
        orders: 0,
        results: 0,
      });
    } finally {
      await stop?.();
      await fx.cleanup(redis);
    }
  });
  it('serves a protected event with the feature on: its own scheduler admits and the purchase commits once', async () => {
    const fx = await purchaseFixture(pool, getConfig().JWT_SECRET);
    await setProtected(fx.eventId, true);
    let stop: (() => Promise<void>) | undefined;
    try {
      const product = await startProduct(true);
      stop = product.stop;
      const [user] = fx.users,
        token = fx.token(user),
        queue = `/events/${fx.eventId}/admissions`;
      // The product's own coordinator publishes the namespace of the protected policy.
      let status = await product.call('GET', `${queue}/me`, token);
      expect(
        await poll(
          async () => (status = await product.call('GET', `${queue}/me`, token)).status === 200,
        ),
      ).toBe(true);
      const epoch = status.body.queue.epoch;
      const joined = await product.call('POST', queue, token, {
        epoch,
        joinRequestId: randomUUID(),
      });
      expect(joined.status).toBe(201);
      const admissionId = joined.body.admission.admissionId;
      expect(
        await poll(async () => {
          status = await product.call('GET', `${queue}/me`, token);
          return status.body.admission?.state === 'admitted';
        }),
      ).toBe(true);
      const purchase = {
        eventId: fx.eventId,
        userId: user,
        tierId: TIER,
        quantity: 1,
        admissionId,
        admissionEpoch: epoch,
      };
      const reserved = await product.call('POST', '/reservations', token, purchase);
      expect(reserved.status).toBe(201);
      const replay = await product.call('POST', '/reservations', token, purchase);
      expect(replay.body.id).toBe(reserved.body.id);
      status = await product.call('GET', `${queue}/me`, token);
      expect(status.body.admission).toMatchObject({
        admissionId,
        state: 'consumed',
        outcome: { kind: 'reservation', resourceId: reserved.body.id, code: null },
      });
      expect(await fx.state()).toMatchObject({
        available: 19,
        held: 1,
        reservations: 1,
        results: 1,
      });
      await fx.verify();
      process.stdout.write(
        JSON.stringify({
          admissionPurchaseProcess: { admissionId, reservationId: reserved.body.id },
        }) + '\n',
      );
    } finally {
      await stop?.();
      await fx.cleanup(redis);
    }
  });
  it('refuses startup on a database without the result ledger of migration 013', async () => {
    // The owned test database is briefly put back to its pre-013 shape and always restored.
    await pool.query('ALTER TABLE admission_results RENAME TO admission_results_hidden');
    try {
      expect(await startupFailure(false)).toContain('admission_results');
    } finally {
      await pool.query('ALTER TABLE admission_results_hidden RENAME TO admission_results');
    }
  });
  it('refuses readiness when the Redis environment violates the accepted volatile profile', async () => {
    await redis.configSet('maxmemory-policy', 'allkeys-lru');
    try {
      expect(await startupFailure(true)).toContain('ADMISSION_UNAVAILABLE');
    } finally {
      await redis.configSet('maxmemory-policy', 'noeviction');
    }
  });
});
