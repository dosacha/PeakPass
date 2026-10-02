import 'dotenv/config';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { initRedis, closeRedis } from '@/infra/redis/client';
import { initLogger } from '@/infra/logger';

describe('admission Redis atomic protocol', () => {
  let redis: Awaited<ReturnType<typeof initRedis>>;
  let api: typeof import('@/infra/redis/admission');
  const eventId = randomUUID(),
    epoch = randomUUID();
  beforeAll(async () => {
    initLogger();
    redis = await initRedis();
    expect(existsSync('src/infra/redis/admission.ts')).toBe(true);
    const path = '@/infra/redis/admission';
    api = await import(path);
    await api.initializeAdmission({ eventId, epoch, generation: '1' }, 'fixture-process');
    await api.publishAdmission(eventId, epoch, '1');
  });
  afterAll(async () => {
    const keys = await redis.keys(`peakpass:admission:${eventId}:*`);
    if (keys.length) await redis.del(keys);
    await closeRedis();
  });
  it('replays a concurrent join and preserves newer identity after old cancel/replay', async () => {
    const userId = randomUUID(),
      joinRequestId = randomUUID();
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        api.runAdmission(eventId, epoch, 'join', {
          userId,
          joinRequestId,
          admissionId: randomUUID(),
        }),
      ),
    );
    expect(new Set(attempts.map((x) => x.entry?.admissionId)).size).toBe(1);
    expect(attempts.filter((x) => x.created)).toHaveLength(1);
    const a = attempts[0].entry!;
    // A fresh user avoids intentionally exhausted registration budget in this identity test.
    const bUser = randomUUID(),
      aJoin = randomUUID();
    const first = await api.runAdmission(eventId, epoch, 'join', {
      userId: bUser,
      joinRequestId: aJoin,
      admissionId: randomUUID(),
    });
    const id = first.entry!.admissionId;
    expect(
      (await api.runAdmission(eventId, epoch, 'cancel', { userId: bUser, admissionId: id })).entry
        ?.state,
    ).toBe('cancelled');
    const second = await api.runAdmission(eventId, epoch, 'join', {
      userId: bUser,
      joinRequestId: randomUUID(),
      admissionId: randomUUID(),
    });
    expect(Number(second.entry!.sequence)).toBeGreaterThan(Number(first.entry!.sequence));
    expect(
      (
        await api.runAdmission(eventId, epoch, 'join', {
          userId: bUser,
          joinRequestId: aJoin,
          admissionId: randomUUID(),
        })
      ).entry?.admissionId,
    ).toBe(id);
    await api.runAdmission(eventId, epoch, 'cancel', { userId: bUser, admissionId: id });
    expect(
      (await api.runAdmission(eventId, epoch, 'status', { userId: bUser })).entry?.admissionId,
    ).toBe(second.entry!.admissionId);
    expect(a.state).toBe('waiting');
  });
  it('shares R across workers and keeps claimed C until durable finalization', async () => {
    const outcomes = await Promise.all([
      api.runAdmission(eventId, epoch, 'tick'),
      api.runAdmission(eventId, epoch, 'tick'),
    ]);
    const promoted = outcomes.flatMap((x) => x.promoted ?? []);
    expect(promoted).toHaveLength(2);
    const entry = (await api.runAdmission(eventId, epoch, 'inspect', { admissionId: promoted[0] }))
      .entry!;
    const input = {
      userId: entry.userId,
      admissionId: entry.admissionId,
      fingerprint: 'canonical',
      claimToken: randomUUID(),
    };
    const claimed = await api.runAdmission(eventId, epoch, 'claim', input);
    expect(claimed.entry?.phase).toBe('processing');
    expect((await api.runAdmission(eventId, epoch, 'cancel', input)).code).toBe(
      'ADMISSION_IN_PROGRESS',
    );
    expect(
      (await api.runAdmission(eventId, epoch, 'claim', { ...input, fingerprint: 'other' })).code,
    ).toBe('ADMISSION_REQUEST_MISMATCH');
    const complete = {
      ...input,
      claimToken: claimed.entry!.claimToken,
      outcome: { kind: 'reservation', resourceId: randomUUID(), code: null },
    };
    expect((await api.runAdmission(eventId, epoch, 'complete', complete)).entry?.state).toBe(
      'consumed',
    );
    expect((await api.runAdmission(eventId, epoch, 'complete', complete)).entry?.state).toBe(
      'consumed',
    );
    expect((await api.runAdmission(eventId, epoch, 'tick')).promoted ?? []).toHaveLength(0);
  });
  it('fails closed on missing metadata and never publishes a frozen generation', async () => {
    await api.freezeAdmission(eventId, epoch, '1');
    expect((await api.publishAdmission(eventId, epoch, '1')).ok).toBe(false);
    expect(
      (await api.runAdmission(eventId, epoch, 'status', { userId: randomUUID() })).status,
    ).toBe(503);
  });
  it('fences a retired-key cleanup that races with a new generation', async () => {
    const observed = await api.getAdmissionControl(eventId);
    const nextEpoch = randomUUID();
    await api.initializeAdmission(
      { eventId, epoch: nextEpoch, generation: '2' },
      'fixture-process',
    );
    await api.publishAdmission(eventId, nextEpoch, '2');
    const newKey = api.admissionKeys(eventId, nextEpoch)[2];
    expect(await api.unlinkRetiredAdmission(eventId, observed!, [newKey])).toBe(0);
    expect(await redis.exists(newKey)).toBe(1);
  });
  it('retires the control with its own epoch keys, including an unreadable control', async () => {
    const current = (await api.getAdmissionControl(eventId))!,
      keys = api.admissionKeys(eventId, current.epoch);
    await api.retireAdmission(eventId);
    expect(await redis.exists(keys.slice(0, 12))).toBe(0);
    // An earlier epoch is not this control's namespace; bounded cleanup owns it after re-protection.
    expect(await redis.exists(api.admissionKeys(eventId, epoch)[2])).toBe(1);
    await redis.set(keys[0], 'not-a-hash');
    await api.retireAdmission(eventId);
    expect(await redis.exists(keys[0])).toBe(0);
    await api.retireAdmission(eventId);
  });
});
