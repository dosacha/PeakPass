import 'dotenv/config';
import { randomUUID } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { once } from 'events';
import { initLogger } from '@/infra/logger';
import { initRedis, closeRedis } from '@/infra/redis/client';
import {
  admissionKeys,
  initializeAdmission,
  publishAdmission,
  runAdmission,
  RedisAdmissionEntry,
  RedisAdmissionResult,
} from '@/infra/redis/admission';

jest.setTimeout(30000);
describe('admission limits with actual Redis and bounded synthetic fixtures', () => {
  let redis: Awaited<ReturnType<typeof initRedis>>;
  let eventId: string, epoch: string, keys: string[];
  beforeAll(async () => {
    initLogger();
    redis = await initRedis();
  });
  beforeEach(async () => {
    eventId = randomUUID();
    epoch = randomUUID();
    keys = admissionKeys(eventId, epoch);
    await initializeAdmission({ eventId, epoch, generation: '1' }, 'fixture');
    await publishAdmission(eventId, epoch, '1');
  });
  afterEach(async () => {
    const owned = await redis.keys(`peakpass:admission:${eventId}:*`);
    if (owned.length) await redis.del(owned);
  });
  afterAll(async () => {
    await closeRedis();
  });
  const join = (userId: string = randomUUID(), joinRequestId: string = randomUUID()) =>
    runAdmission(eventId, epoch, 'join', { userId, joinRequestId, admissionId: randomUUID() });
  const command = (
    op: Parameters<typeof runAdmission>[2],
    entry: RedisAdmissionEntry,
    extra = {},
  ) =>
    runAdmission(eventId, epoch, op, {
      userId: entry.userId,
      admissionId: entry.admissionId,
      ...extra,
    });
  async function age(entry: RedisAdmissionEntry, fields: Partial<RedisAdmissionEntry>) {
    Object.assign(entry, fields);
    await redis.hSet(keys[2], entry.admissionId, JSON.stringify(entry));
    if (entry.state === 'waiting')
      await redis.zAdd(keys[7], { score: entry.expiresAt!, value: entry.admissionId });
    if (entry.phase !== 'idle')
      await redis.zAdd(keys[9], { score: entry.deadline!, value: entry.admissionId });
  }
  it('shares FIFO, rolling R=2 and C=8 across two worker processes without accumulating delayed budget', async () => {
    const entries = (await Promise.all(Array.from({ length: 12 }, () => join())))
      .map((x) => x.entry!)
      .sort((a, b) => Number(a.sequence) - Number(b.sequence));
    const workers: ChildProcess[] = [];
    const promoted: { id: string; at: number }[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const worker = spawn(
          process.execPath,
          ['--import', 'tsx', 'src/tests/integration/admission-worker-fixture.ts'],
          { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true },
        );
        workers.push(worker);
        expect((await once(worker, 'message'))[0]).toEqual({ ready: true });
      }
      for (let round = 0; round < 4; round++) {
        const results = await Promise.all(
          workers.map(async (worker) => {
            const response = once(worker, 'message');
            worker.send({ eventId, epoch });
            return (await response)[0] as RedisAdmissionResult;
          }),
        );
        for (const result of results) {
          expect(result.ok).toBe(true);
          for (const id of result.promoted ?? []) promoted.push({ id, at: result.now });
        }
        if (round < 3) await new Promise((resolve) => setTimeout(resolve, 1050));
      }
      expect(promoted.map((p) => p.id)).toEqual(entries.slice(0, 8).map((e) => e.admissionId));
      for (const p of promoted)
        expect(
          promoted.filter((q) => q.at > p.at - 1000 && q.at <= p.at).length,
        ).toBeLessThanOrEqual(2);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect((await runAdmission(eventId, epoch, 'tick')).promoted).toEqual([]);
      for (const e of entries.slice(0, 4)) await command('cancel', e);
      expect((await runAdmission(eventId, epoch, 'tick')).promoted).toHaveLength(2);
      expect((await runAdmission(eventId, epoch, 'tick')).promoted).toEqual([]);
      process.stdout.write(
        JSON.stringify({ admissionRollingWindow: promoted, capacity: 8 }) + '\n',
      );
    } finally {
      for (const worker of workers)
        if (worker.connected) {
          const exited = once(worker, 'exit');
          worker.disconnect();
          await exited;
        }
    }
  });
  it('keeps overdue claims in C and finalizes only matching tokens, with one cancel/claim race winner', async () => {
    const waiting = (await Promise.all([join(), join()])).map((x) => x.entry!);
    await runAdmission(eventId, epoch, 'tick');
    const entry = (await command('inspect', waiting[0])).entry!;
    const token = randomUUID(),
      input = { fingerprint: 'same-command', claimToken: token };
    const claimed = (await command('claim', entry, input)).entry!;
    await age(claimed, { expiresAt: claimed.joinedAt - 1 });
    const retry = await command('claim', claimed, { ...input, claimToken: randomUUID() });
    expect(retry.entry).toMatchObject({ claimToken: token, deadline: claimed.deadline });
    await age(claimed, { deadline: claimed.joinedAt - 1 });
    const reconciled = await runAdmission(eventId, epoch, 'reconcile');
    expect(reconciled.claims).toHaveLength(1);
    expect(reconciled.claims![0].phase).toBe('reconciling');
    await runAdmission(eventId, epoch, 'tick');
    expect(await redis.zScore(keys[8], claimed.admissionId)).not.toBeNull();
    expect((await command('claim', claimed, input)).code).toBe('ADMISSION_IN_PROGRESS');
    expect((await command('close', claimed, { ...input, claimToken: randomUUID() })).code).toBe(
      'ADMISSION_REQUEST_MISMATCH',
    );
    for (let n = 0; n < 2; n++)
      expect((await command('close', claimed, input)).entry?.state).toBe('expired');
    expect(await redis.zScore(keys[8], claimed.admissionId)).toBeNull();
    const race = await Promise.all([
      command('claim', waiting[1], input),
      command('cancel', waiting[1]),
    ]);
    expect(race.filter((x) => x.ok)).toHaveLength(1);
    expect(race.find((x) => !x.ok)?.code).toMatch(/ADMISSION_(IN_PROGRESS|CANCELLED)/);
  });
  it('renews waiting only on successful status/join, separates action limits and expires idle logically', async () => {
    const key = randomUUID(),
      joined = await join(randomUUID(), key),
      entry = joined.entry!;
    await age(entry, { expiresAt: joined.now + 1000 });
    const refreshed = await command('status', entry);
    expect(refreshed.entry!.expiresAt).toBe(refreshed.now + 120000);
    for (let i = 1; i < 120; i++) await command('status', entry);
    const before = await redis.hGet(keys[2], entry.admissionId);
    expect((await command('status', entry)).status).toBe(429);
    expect(await redis.hGet(keys[2], entry.admissionId)).toBe(before);
    expect((await join(entry.userId, key)).ok).toBe(true);
    expect((await command('cancel', entry)).ok).toBe(true);
    const next = (await join(entry.userId)).entry!;
    await age(next, { expiresAt: joined.now - 1 });
    expect((await command('cancel', next)).entry?.state).toBe('expired');
    const idle = (await join()).entry!;
    await runAdmission(eventId, epoch, 'tick');
    const admitted = (await command('inspect', idle)).entry!;
    await age(admitted, { expiresAt: joined.now - 1 });
    expect(
      (await command('claim', admitted, { fingerprint: 'x', claimToken: randomUUID() })).status,
    ).toBe(410);
  });
  it('caps waiting at 1000, keeps replay at full, and drains at most 100 expired leases per tick', async () => {
    // Initial population is a bounded fixture, not a load/capacity measurement.
    const entries: RedisAdmissionEntry[] = [];
    for (let n = 0; n < 10; n++)
      entries.push(
        ...(await Promise.all(Array.from({ length: 100 }, () => join()))).map((x) => x.entry!),
      );
    expect((await join()).code).toBe('ADMISSION_QUEUE_FULL');
    const first = entries[0];
    const originalJoin = Object.entries(await redis.hGetAll(keys[3])).find(
      ([, id]) => id === first.admissionId,
    )![0];
    expect((await join(first.userId, originalJoin)).entry?.admissionId).toBe(first.admissionId);
    for (const e of entries.slice(0, 101)) await age(e, { expiresAt: e.joinedAt - 1 });
    const tick = await runAdmission(eventId, epoch, 'tick');
    expect(tick.cleaned).toBe(100);
    expect(tick.promoted).toEqual([]);
    const next = await runAdmission(eventId, epoch, 'tick');
    expect(next.cleaned).toBe(1);
    expect(next.promoted).toHaveLength(2);
    expect((await command('inspect', first)).entry?.state).toBe('expired');
    expect(await redis.ttl(keys[2])).toBe(-1);
  });
  it('caps epoch entries at 10000 while retaining terminal replay and current status', async () => {
    const joinId = randomUUID(),
      first = (await join(randomUUID(), joinId)).entry!;
    await command('cancel', first);
    // Seed terminal history directly; each hash/index invariant remains valid.
    const entries: Record<string, string> = {},
      joins: Record<string, string> = {};
    for (let n = 2; n <= 10000; n++) {
      const id = randomUUID();
      entries[id] = JSON.stringify({
        ...first,
        admissionId: id,
        sequence: String(n),
        state: 'cancelled',
        expiresAt: null,
      });
      joins[randomUUID()] = id;
    }
    await redis.hSet(keys[2], entries);
    await redis.hSet(keys[3], joins);
    await redis.set(keys[11], '10000');
    expect((await join()).code).toBe('ADMISSION_QUEUE_FULL');
    expect((await join(first.userId, joinId)).entry?.state).toBe('cancelled');
    expect((await command('status', first)).entry?.admissionId).toBe(first.admissionId);
  });
  it.each(['missing', 'wrong-type', 'dirty', 'expired-session'])(
    'fails closed for %s metadata before renewing any lease',
    async (fault) => {
      const entry = (await join()).entry!,
        before = await redis.hGet(keys[2], entry.admissionId);
      if (fault === 'missing') await redis.del(keys[7]);
      if (fault === 'wrong-type') {
        await redis.del(keys[7]);
        await redis.set(keys[7], 'bad');
      }
      if (fault === 'dirty') await redis.hSet(keys[0], 'dirty', '1');
      if (fault === 'expired-session') await redis.hSet(keys[1], 'endAt', '1');
      expect((await command('status', entry)).status).toBe(503);
      expect(await redis.hGet(keys[2], entry.admissionId)).toBe(before);
    },
  );
});
