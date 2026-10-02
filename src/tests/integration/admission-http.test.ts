import 'dotenv/config';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import jwt from 'jsonwebtoken';
import { initRedis, closeRedis } from '@/infra/redis/client';
import {
  initPostgresPool,
  closePostgresPool,
  serializableTransactionWithRetry,
} from '@/infra/postgres/client';
import { getConfig } from '@/infra/config';
import { initLogger } from '@/infra/logger';
import { readAdmissionPolicy, policyColumns } from '@/infra/postgres/admission-policy';
import { blocked } from './order-sweeper-fixture';

jest.mock('@/infra/config', () => {
  const actual = jest.requireActual('@/infra/config');
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), ENABLE_ADMISSION: true }) };
});

describe('admission actual authenticated HTTP and epoch lifecycle', () => {
  let pool: Awaited<ReturnType<typeof initPostgresPool>>;
  let redis: Awaited<ReturnType<typeof initRedis>>;
  let service: import('@/core/services/admission.service').AdmissionService;
  let app: Awaited<ReturnType<typeof import('@/api/app').createApp>>;
  const eventId = randomUUID(),
    userId = randomUUID();
  let base = '',
    epoch = '',
    authorization = '';
  beforeAll(async () => {
    initLogger();
    pool = await initPostgresPool();
    redis = await initRedis();
    await pool.query(
      `INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats)
      VALUES($1,'p4 http',NOW(),NOW()+interval '1 day',10,10)`,
      [eventId],
    );
    expect(existsSync('src/core/services/admission.service.ts')).toBe(true);
    const sp = '@/core/services/admission.service';
    service = (await import(sp)).admissionService;
    await pool.query(
      `INSERT INTO admission_events(event_id,protected,redis_namespace)
      VALUES($1::uuid,true,'peakpass:admission:'||$1::uuid::text||':')`,
      [eventId],
    );
    await service.verifyEnvironment();
    await service.recover(eventId);
    epoch = (await service.status(eventId, userId)).queue.epoch;
    app = await (await import('@/api/app')).createApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    authorization = `Bearer ${jwt.sign({ sub: userId }, getConfig().JWT_SECRET)}`;
  });
  afterAll(async () => {
    await app?.close();
    await pool.query('DELETE FROM events WHERE id=$1', [eventId]);
    const keys = await redis.keys(`peakpass:admission:${eventId}:*`);
    if (keys.length) await redis.del(keys);
    await closeRedis();
    await closePostgresPool();
  });
  async function request(path: string, method = 'GET', body?: unknown, auth = authorization) {
    const response = await fetch(base + path, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as any,
      headers: response.headers,
    };
  }
  it('enforces JWT and strict schema with exact admission envelope', async () => {
    const url = `/events/${eventId}/admissions/me`;
    for (const auth of ['', 'Bearer invalid']) {
      const r = await request(url, 'GET', undefined, auth);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({
        error: { code: 'UNAUTHENTICATED', message: expect.any(String) },
        nextPollAfterMs: null,
      });
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    const r = await request(`/events/${eventId}/admissions`, 'POST', {
      epoch,
      joinRequestId: randomUUID(),
      userId,
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('ADMISSION_INVALID_INPUT');
  });
  it('returns matching epochs and does no PG work during normal status polling', async () => {
    const r = await request(`/events/${eventId}/admissions`, 'POST', {
      epoch,
      joinRequestId: randomUUID(),
    });
    expect(r.status).toBe(201);
    expect(r.body.admission.sequence).toBe('1');
    const spy = jest.spyOn(pool, 'connect'),
      query = jest.spyOn(pool, 'query');
    try {
      const status = await request(`/events/${eventId}/admissions/me`);
      expect(status.status).toBe(200);
      expect(status.body.queue.epoch).toBe(status.body.admission.epoch);
      expect(spy).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      query.mockRestore();
    }
  });
  it('classifies oversized and malformed bodies as input errors without retry advice', async () => {
    const oversized = await request(`/events/${eventId}/admissions`, 'POST', {
      padding: 'x'.repeat(1048576),
    });
    expect(oversized.status).toBe(400);
    expect(oversized.body.nextPollAfterMs).toBeNull();
    const malformed = await fetch(base + `/events/${eventId}/admissions`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: 'ADMISSION_INVALID_INPUT' },
      nextPollAfterMs: null,
    });
  });
  it('replays concurrent joins, preserves owner privacy and returns the limiter minimum', async () => {
    const owner = randomUUID(),
      joinRequestId = randomUUID();
    const auth = `Bearer ${jwt.sign({ sub: owner }, getConfig().JWT_SECRET)}`;
    const url = `/events/${eventId}/admissions`;
    const before = await redis.keys(`peakpass:ratelimit:*:${owner}`);
    const joins = await Promise.all(
      Array.from({ length: 10 }, () => request(url, 'POST', { epoch, joinRequestId }, auth)),
    );
    expect(joins.filter((x) => x.status === 201)).toHaveLength(1);
    expect(joins.filter((x) => x.status === 200)).toHaveLength(9);
    expect(new Set(joins.map((x) => x.body.admission.admissionId)).size).toBe(1);
    const id = joins[0].body.admission.admissionId;
    const replay = await request(url, 'POST', { epoch, joinRequestId }, auth);
    expect(replay.status).toBe(429);
    expect(Number(replay.headers.get('retry-after'))).toBe(
      Math.ceil(replay.body.nextPollAfterMs / 1000),
    );
    const status = await request(url + '/me', 'GET', undefined, auth);
    expect(status.body.admission.admissionId).toBe(id);
    expect(status.body.admission).not.toHaveProperty('claimToken');
    const foreign = await request(url, 'POST', { epoch, joinRequestId });
    expect(foreign.status).toBe(409);
    expect(foreign.body).not.toHaveProperty('admission');
    expect((await request(url + '/' + id, 'DELETE', { epoch })).status).toBe(404);
    const active = await request(url, 'POST', { epoch, joinRequestId: randomUUID() });
    expect(active.status).toBe(409);
    expect(active.body.error.code).toBe('ACTIVE_ADMISSION_EXISTS');
    expect(active.body.admission.admissionId).not.toBe(id);
    expect(await redis.keys(`peakpass:ratelimit:*:${owner}`)).toEqual(before);
  });
  it('serializes two recovery coordinators and rejects the retired epoch', async () => {
    const before = await service.control(eventId);
    await service.freeze(eventId, before!);
    await Promise.all([service.recover(eventId, before!), service.recover(eventId, before!)]);
    const after = await service.control(eventId);
    expect(BigInt(after!.generation)).toBe(BigInt(before!.generation) + 1n);
    const stale = await request(`/events/${eventId}/admissions`, 'POST', {
      epoch,
      joinRequestId: randomUUID(),
    });
    expect(stale.status).toBe(410);
    expect(stale.body.error.code).toBe('ADMISSION_RESET');
  });
  it('adopts recovery completed after a missing-control observation', async () => {
    const before = await service.control(eventId);
    await service.recover(eventId, null);
    expect(await service.control(eventId)).toEqual(before);
  });
  it('waits for existing shared-gate transactions before publishing a new epoch', async () => {
    const c = await pool.connect();
    let recovery: Promise<void> | undefined;
    try {
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const policy = await readAdmissionPolicy(c, eventId, 'shared');
      const before = await service.control(eventId);
      recovery = service.recover(eventId, before);
      await blocked(pool, pid);
      expect((await service.control(eventId))!.mode).toBe('frozen');
      expect(
        (
          await pool.query('SELECT generation::text FROM admission_events WHERE event_id=$1', [
            eventId,
          ])
        ).rows[0].generation,
      ).toBe(policy.generation);
      await c.query('COMMIT');
      await recovery;
      expect(BigInt((await service.control(eventId))!.generation)).toBe(
        BigInt(policy.generation) + 1n,
      );
      expect((await service.control(eventId))!.mode).toBe('ready');
    } finally {
      await c.query('ROLLBACK');
      c.release();
      await recovery?.catch(() => undefined);
    }
  });
  it.each(['recovering', 'open'])(
    'resumes intact initializing data after the PG %s commit',
    async (phase) => {
      const { initializeAdmission } = await import('@/infra/redis/admission');
      const next = (
        await pool.query(
          `UPDATE admission_events SET generation=generation+1,epoch=$2,phase=$3
      WHERE event_id=$1 RETURNING generation::text,epoch`,
          [eventId, randomUUID(), phase],
        )
      ).rows[0];
      const before = await service.control(eventId);
      await initializeAdmission({ eventId, ...next }, before!.runId);
      const initializing = await service.control(eventId);
      expect(initializing!.mode).toBe('initializing');
      await service.recover(eventId, initializing);
      expect(await service.control(eventId)).toMatchObject({ ...next, mode: 'ready' });
    },
  );
  it('allocates a fresh generation after partial initialization instead of erasing it', async () => {
    const { initializeAdmission, admissionKeys } = await import('@/infra/redis/admission');
    const next = (
      await pool.query(
        `UPDATE admission_events SET generation=generation+1,epoch=$2,phase='recovering'
      WHERE event_id=$1 RETURNING generation::text,epoch`,
        [eventId, randomUUID()],
      )
    ).rows[0];
    const before = await service.control(eventId);
    await initializeAdmission({ eventId, ...next }, before!.runId);
    await redis.del(admissionKeys(eventId, next.epoch)[7]);
    await service.recover(eventId, await service.control(eventId));
    expect(BigInt((await service.control(eventId))!.generation)).toBe(BigInt(next.generation) + 1n);
    expect(await redis.exists(admissionKeys(eventId, next.epoch)[2])).toBe(1);
  });
  it('returns recovering rather than stale-client 410 when GET races with reset', async () => {
    const before = await service.control(eventId);
    await service.recover(eventId, before);
    const spy = jest.spyOn(service, 'control').mockResolvedValueOnce(before);
    try {
      const response = await request(`/events/${eventId}/admissions/me`);
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('ADMISSION_RECOVERING');
    } finally {
      spy.mockRestore();
      await service.verifyEnvironment();
    }
  });
  it.each(['epoch', 'phase'])(
    'preserves a newly recovered registration after a stale PG %s snapshot',
    async (field) => {
      const stale = (
        await pool.query(`SELECT ${policyColumns} FROM admission_events WHERE event_id=$1`, [
          eventId,
        ])
      ).rows[0];
      if (field === 'epoch') await service.recover(eventId, await service.control(eventId));
      else stale.phase = 'recovering';
      const current = (await service.control(eventId))!,
        owner = randomUUID();
      const joined = await service.join(eventId, owner, current.epoch, randomUUID());
      // Freeze the maintenance SELECT's result at its earlier observation; all following PG/Redis calls are real.
      const query = jest.spyOn(pool, 'query').mockResolvedValueOnce({ rows: [stale] } as never);
      try {
        await service.maintain();
        expect(await service.control(eventId)).toEqual(current);
        expect((await service.status(eventId, owner)).admission?.admissionId).toBe(
          joined.body.admission!.admissionId,
        );
      } finally {
        query.mockRestore();
      }
    },
  );
  it('keeps the epoch and queue after a transient command failure on an intact namespace', async () => {
    const before = (await service.control(eventId))!,
      owner = randomUUID();
    expect(before.mode).toBe('ready');
    const joined = await service.join(eventId, owner, before.epoch, randomUUID());
    // Fault injection: only this tick's first Lua command is lost; every later Redis/PG call is real.
    const evaluate = jest
      .spyOn(redis, 'eval')
      .mockRejectedValueOnce(new Error('Socket closed unexpectedly'));
    try {
      await service.maintain();
      expect((evaluate.mock.calls[0][1] as { arguments: string[] }).arguments[0]).toBe('tick');
    } finally {
      evaluate.mockRestore();
    }
    expect(await service.control(eventId)).toEqual(before);
    expect((await service.status(eventId, owner)).admission?.admissionId).toBe(
      joined.body.admission!.admissionId,
    );
  });
  it('still resets through the same failure path once namespace loss is established', async () => {
    const { admissionKeys } = await import('@/infra/redis/admission');
    const before = (await service.control(eventId))!;
    // The waiting index is gone: the failed tick now reports corruption rather than a lost reply.
    await redis.del(admissionKeys(eventId, before.epoch)[6]);
    await service.maintain();
    const after = (await service.control(eventId))!;
    expect(after.mode).toBe('ready');
    expect(BigInt(after.generation)).toBe(BigInt(before.generation) + 1n);
    expect(after.epoch).not.toBe(before.epoch);
  });
  it('finalizes an approved claim after the session deadline, then rolls the ended epoch over', async () => {
    const { admissionKeys } = await import('@/infra/redis/admission');
    const before = (await service.control(eventId))!,
      owner = randomUUID();
    const admissionId = (await service.join(eventId, owner, before.epoch, randomUUID())).body
      .admission!.admissionId;
    expect((await service.promote(eventId)).promoted).toEqual([admissionId]);
    const claim = await service.claim({
      eventId,
      userId: owner,
      admissionId,
      epoch: before.epoch,
      fingerprint: 'canonical',
    });
    // Synthetic deadline: the session ends after the claim was approved, before its result is reflected.
    await redis.hSet(admissionKeys(eventId, before.epoch)[1], 'endAt', '1');
    const outcome = { kind: 'reservation' as const, resourceId: randomUUID(), code: null };
    expect((await service.complete(claim, outcome)).entry).toMatchObject({
      state: 'consumed',
      outcome,
    });
    expect(service.isReady()).toBe(true);
    // For the next tick the ended session is an established loss, not a lost reply.
    await service.maintain();
    const after = (await service.control(eventId))!;
    expect(after.mode).toBe('ready');
    expect(BigInt(after.generation)).toBe(BigInt(before.generation) + 1n);
    await expect(service.complete(claim, outcome)).rejects.toMatchObject({
      code: 'ADMISSION_RESET',
      statusCode: 410,
    });
  });
  // P4 has no release route. The fixture performs the contract's explicit transition under the exclusive gate.
  const setProtected = (value: boolean) =>
    serializableTransactionWithRetry(async (c) => {
      await readAdmissionPolicy(c, eventId, 'exclusive');
      await c.query('UPDATE admission_events SET protected=$2 WHERE event_id=$1', [eventId, value]);
    });
  const policy = async () =>
    (await pool.query(`SELECT ${policyColumns} FROM admission_events WHERE event_id=$1`, [eventId]))
      .rows[0];
  it('retires a released policy namespace so the API reports ADMISSION_NOT_ENABLED', async () => {
    const before = (await service.control(eventId))!;
    expect(before.mode).toBe('ready');
    await service.join(eventId, randomUUID(), before.epoch, randomUUID());
    await setProtected(false);
    try {
      // Two coordinators observe the same release; the barrier retires and advances exactly once.
      await Promise.all([service.maintain(), service.maintain()]);
      expect(await service.control(eventId)).toBeNull();
      expect(await redis.keys(`peakpass:admission:${eventId}:${before.epoch}:*`)).toEqual([]);
      const retired = await policy();
      expect(retired).toMatchObject({
        protected: false,
        phase: 'recovering',
        generation: String(BigInt(before.generation) + 1n),
      });
      expect(retired.epoch).not.toBe(before.epoch);
      for (const response of [
        await request(`/events/${eventId}/admissions/me`),
        await request(`/events/${eventId}/admissions`, 'POST', {
          epoch: before.epoch,
          joinRequestId: randomUUID(),
        }),
      ]) {
        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          error: { code: 'ADMISSION_NOT_ENABLED', message: expect.any(String) },
          nextPollAfterMs: null,
        });
      }
      // Nothing is left to select: a second tick neither recreates Redis state nor advances PG again.
      await service.maintain();
      expect(await service.control(eventId)).toBeNull();
      expect(await policy()).toEqual(retired);
      // Protection opens the epoch allocated at retirement; the retired epoch is never published again.
      await setProtected(true);
      await service.recover(eventId);
      expect(await service.control(eventId)).toMatchObject({
        mode: 'ready',
        generation: retired.generation,
        epoch: retired.epoch,
      });
      const stale = await request(`/events/${eventId}/admissions`, 'POST', {
        epoch: before.epoch,
        joinRequestId: randomUUID(),
      });
      expect(stale.status).toBe(410);
      expect(stale.body.error.code).toBe('ADMISSION_RESET');
    } finally {
      if (!(await policy()).protected) {
        await setProtected(true);
        await service.recover(eventId);
      }
    }
  });
  it('retires instead of abandoning a frozen namespace when recovery finds the policy released', async () => {
    const before = (await service.control(eventId))!;
    expect(before.mode).toBe('ready');
    await service.freeze(eventId, before);
    await setProtected(false);
    try {
      await service.recover(eventId, before);
      expect(await service.control(eventId)).toBeNull();
      const response = await request(`/events/${eventId}/admissions/me`);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('ADMISSION_NOT_ENABLED');
    } finally {
      await setProtected(true);
      await service.recover(eventId);
    }
    expect((await service.control(eventId))!.mode).toBe('ready');
  });
  it.each([2, 3])(
    'retires what an in-flight recovery left when the release commits before its transaction %i',
    async (transaction) => {
      const before = (await service.control(eventId))!;
      expect(before.mode).toBe('ready');
      const connect = pool.connect.bind(pool) as unknown as () => Promise<unknown>;
      let connections = 0;
      // Real interleaving: the release commits under the exclusive gate between two recovery transactions.
      const spy = jest.spyOn(pool, 'connect').mockImplementation((async () => {
        if (++connections === transaction) {
          spy.mockRestore();
          await setProtected(false);
        }
        return connect();
      }) as never);
      try {
        await service.recover(eventId, before);
        expect(await service.control(eventId)).toBeNull();
        const released = await policy();
        expect(released).toMatchObject({ protected: false, phase: 'recovering' });
        expect(await redis.keys(`peakpass:admission:${eventId}:${released.epoch}:*`)).toEqual([]);
        const response = await request(`/events/${eventId}/admissions/me`);
        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('ADMISSION_NOT_ENABLED');
      } finally {
        spy.mockRestore();
        if (!(await policy()).protected) {
          await setProtected(true);
          await service.recover(eventId);
        }
      }
      expect((await service.control(eventId))!.mode).toBe('ready');
    },
  );
  it.each(['a deleted event', 'a policy released while recovering'])(
    'retires the orphaned control of %s through the bounded sweep',
    async (kind) => {
      const { initializeAdmission, publishAdmission, freezeAdmission, getAdmissionControl } =
        await import('@/infra/redis/admission');
      const guarded = (await service.control(eventId))!,
        orphan = randomUUID(),
        orphanEpoch = randomUUID(),
        url = `/events/${orphan}/admissions/me`;
      expect(guarded.mode).toBe('ready');
      await pool.query(
        `INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats)
        VALUES($1,'p4 orphan',NOW(),NOW()+interval '1 day',10,10)`,
        [orphan],
      );
      try {
        // Fixture: a namespace published before its policy row disappeared or its release went unseen.
        await initializeAdmission(
          { eventId: orphan, epoch: orphanEpoch, generation: '1' },
          guarded.runId,
        );
        await publishAdmission(orphan, orphanEpoch, '1');
        if (kind === 'a deleted event')
          await pool.query('DELETE FROM events WHERE id=$1', [orphan]);
        else await freezeAdmission(orphan, orphanEpoch, '1');
        // No policy row selects this control, so until the sweep reaches it Redis still answers.
        expect((await request(url)).status).toBe(kind === 'a deleted event' ? 200 : 503);
        for (let tick = 0; tick < 50 && (await getAdmissionControl(orphan)); tick++)
          await service.maintain();
        expect(await getAdmissionControl(orphan)).toBeNull();
        const response = await request(url);
        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('ADMISSION_NOT_ENABLED');
        expect(await service.control(eventId)).toEqual(guarded);
      } finally {
        await pool.query('DELETE FROM events WHERE id=$1', [orphan]);
        const keys = await redis.keys(`peakpass:admission:${orphan}:*`);
        if (keys.length) await redis.del(keys);
      }
    },
  );
});
