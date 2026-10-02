import 'dotenv/config';
import { randomUUID } from 'crypto';
import { initRedis, closeRedis } from '@/infra/redis/client';
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';
import { getConfig } from '@/infra/config';
import { initLogger } from '@/infra/logger';
import { admissionKeys } from '@/infra/redis/admission';
import { InventoryService } from '@/core/services/inventory.service';
import { ReservationService } from '@/core/services/reservation.service';
import {
  purchaseFixture,
  PurchaseFixture,
  setProtected,
  admit,
  inspect,
  age,
  slots,
  TIER,
} from './admission-purchase-fixture';

jest.mock('@/infra/config', () => {
  const actual = jest.requireActual('@/infra/config');
  return {
    ...actual,
    getConfig: () => ({
      ...actual.getConfig(),
      ENABLE_ADMISSION: true,
      // The purchase limiter (5/min) is not under test here; rate-limit-atomic covers it.
      RATE_LIMIT_MAX_REQUESTS: 100000,
    }),
  };
});
jest.setTimeout(60000);

type Admission = { admissionId: string; admissionEpoch: string };
const admissionError = (code: string, nextPollAfterMs: number | null = null) => ({
  error: { code, message: expect.any(String) },
  nextPollAfterMs,
});
const pgError = (code: string) => Object.assign(new Error(`injected ${code}`), { code });

describe('admission purchase gate on owned PostgreSQL, Redis and loopback HTTP', () => {
  let pool: Awaited<ReturnType<typeof initPostgresPool>>;
  let redis: Awaited<ReturnType<typeof initRedis>>;
  let service: import('@/core/services/admission.service').AdmissionService;
  let app: Awaited<ReturnType<typeof import('@/api/app').createApp>>;
  let base = '';
  let fx: PurchaseFixture;
  const fixtures: PurchaseFixture[] = [];

  beforeAll(async () => {
    initLogger();
    pool = await initPostgresPool();
    redis = await initRedis();
    service = (await import('@/core/services/admission.service')).admissionService;
    await service.verifyEnvironment();
    app = await (await import('@/api/app')).createApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    try {
      for (const fixture of fixtures) await fixture.verify();
    } finally {
      for (const fixture of fixtures.splice(0)) await fixture.cleanup(redis);
    }
  });
  afterAll(async () => {
    await app?.close();
    await closeRedis();
    await closePostgresPool();
  });

  async function fixture(seats = 20, isProtected = true) {
    const created = await purchaseFixture(pool, getConfig().JWT_SECRET, seats);
    fixtures.push(created);
    if (isProtected) {
      await setProtected(created.eventId, true);
      await service.recover(created.eventId);
    }
    return created;
  }
  async function request(method: string, path: string, body: unknown, headers: object = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  }
  const reserve = (userId: string, admission: Partial<Admission> = {}, changes: object = {}) =>
    request(
      'POST',
      '/reservations',
      { eventId: fx.eventId, userId, tierId: TIER, quantity: 1, ...admission, ...changes },
      { authorization: fx.token(userId) },
    );

  describe('new reservation', () => {
    it('requires both admission fields on a protected event and creates nothing without them', async () => {
      fx = await fixture();
      const [user] = fx.users,
        id = randomUUID();
      for (const fields of [
        {},
        { admissionId: id },
        { admissionEpoch: id },
        { admissionId: 'not-a-uuid', admissionEpoch: id },
        { admissionId: id, admissionEpoch: null },
      ]) {
        const response = await reserve(user, fields as Partial<Admission>);
        expect(response.status).toBe(400);
        expect(response.body).toEqual(admissionError('ADMISSION_INVALID_INPUT'));
      }
      expect(await fx.state()).toMatchObject({ available: 20, reservations: 0, results: 0 });
    });

    it('consumes an admitted admission once and commits the reservation with its result', async () => {
      fx = await fixture();
      const [user] = fx.users,
        admission = await admit(service, fx.eventId, user);
      expect(await slots(redis, fx.eventId, admission.admissionEpoch)).toBe(1);
      const response = await reserve(user, admission);
      expect(response.status).toBe(201);
      // The success body keeps the existing reservation schema.
      expect(Object.keys(response.body).sort()).toEqual(
        ['createdAt', 'eventId', 'expiresAt', 'id', 'quantity', 'status', 'tierId', 'updatedAt', 'userId'],
      );
      expect(response.body).toMatchObject({ userId: user, eventId: fx.eventId, status: 'active' });
      expect(await fx.state()).toMatchObject({ available: 19, held: 1, reservations: 1, results: 1 });
      expect(await fx.results()).toEqual([
        {
          admissionId: admission.admissionId,
          userId: user,
          epoch: admission.admissionEpoch,
          operation: 'reservation',
          fingerprint: JSON.stringify([
            user,
            fx.eventId,
            admission.admissionEpoch,
            'reservation',
            TIER,
            1,
            null,
          ]),
          outcome: 'consumed',
          reservationId: response.body.id,
          orderId: null,
          errorCode: null,
          httpStatus: null,
          errorMessage: null,
        },
      ]);
      // Redis reflects the committed result and returns the slot exactly once.
      expect(await inspect(fx.eventId, admission.admissionEpoch, admission.admissionId)).toMatchObject({
        state: 'consumed',
        phase: 'idle',
        outcome: { kind: 'reservation', resourceId: response.body.id, code: null },
      });
      expect(await slots(redis, fx.eventId, admission.admissionEpoch)).toBe(0);
    });

    it('replays the same request with the same reservation, sequentially and under a ten-way race', async () => {
      fx = await fixture();
      const [first, second] = fx.users;
      const admission = await admit(service, fx.eventId, first);
      const created = await reserve(first, admission);
      expect(created.status).toBe(201);
      const replay = await reserve(first, admission);
      expect(replay.status).toBe(201);
      expect(replay.body.id).toBe(created.body.id);
      // A fresh admission whose first ten requests all race for the same result.
      const racing = await admit(service, fx.eventId, second);
      const responses = await Promise.all(Array.from({ length: 10 }, () => reserve(second, racing)));
      expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
      expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
      expect(await fx.state()).toMatchObject({ available: 18, held: 2, reservations: 2, results: 2 });
    });

    it('answers 409 to a changed request and 404 to another user, before and after consumption', async () => {
      fx = await fixture();
      const [owner, stranger] = fx.users,
        admission = await admit(service, fx.eventId, owner);
      // Before consumption the stranger cannot learn of or use the admission.
      const early = await reserve(stranger, admission);
      expect(early.status).toBe(404);
      expect(early.body).toEqual(admissionError('ADMISSION_NOT_FOUND'));
      expect((await reserve(owner, admission)).status).toBe(201);
      for (const changes of [{ quantity: 2 }, { tierId: 'vip' }]) {
        const changed = await reserve(owner, admission, changes);
        expect(changed.status).toBe(409);
        expect(changed.body).toEqual(admissionError('ADMISSION_REQUEST_MISMATCH'));
      }
      const late = await reserve(stranger, admission);
      expect(late.status).toBe(404);
      expect(late.body).toEqual(admissionError('ADMISSION_NOT_FOUND'));
      expect(await fx.state()).toMatchObject({ available: 19, reservations: 1, results: 1 });
    });

    it('rejects waiting, cancelled and expired admissions without touching inventory', async () => {
      fx = await fixture();
      const [waitingUser, cancelledUser, expiredUser] = fx.users;
      const epoch = (await service.control(fx.eventId))!.epoch;
      const cancelled = await admit(service, fx.eventId, cancelledUser);
      await service.cancel(fx.eventId, cancelledUser, epoch, cancelled.admissionId);
      const expired = await admit(service, fx.eventId, expiredUser);
      // Synthetic TTL passage: the admission window ended before the first claim.
      await age(redis, fx.eventId, epoch, expired.admissionId, { expiresAt: 1 });
      const waiting = (await service.join(fx.eventId, waitingUser, epoch, randomUUID())).body
        .admission!;
      expect(waiting.state).toBe('waiting');
      const cases: Array<[string, Admission, number, string]> = [
        [waitingUser, { admissionId: waiting.admissionId, admissionEpoch: epoch }, 409, 'ADMISSION_NOT_READY'],
        [cancelledUser, cancelled, 410, 'ADMISSION_CANCELLED'],
        [expiredUser, expired, 410, 'ADMISSION_EXPIRED'],
      ];
      for (const [user, admission, status, code] of cases) {
        const response = await reserve(user, admission);
        expect(response.status).toBe(status);
        expect(response.body).toEqual(admissionError(code));
      }
      expect(await fx.state()).toMatchObject({ available: 20, reservations: 0, results: 0 });
    });

    it('stores a sold-out rejection once and replays it after stock returns', async () => {
      fx = await fixture(1);
      const [buyer, late] = fx.users;
      const held = await reserve(buyer, await admit(service, fx.eventId, buyer));
      expect(held.status).toBe(201);
      const admission = await admit(service, fx.eventId, late);
      const rejected = await reserve(late, admission);
      expect(rejected.status).toBe(409);
      // An existing business error keeps its own code, status and envelope.
      expect(rejected.body).toMatchObject({
        error: {
          code: 'INSUFFICIENT_INVENTORY',
          message: 'Insufficient inventory. Available: 0, Requested: 1',
        },
        requestId: expect.any(String),
      });
      expect((await fx.results())[1]).toMatchObject({
        admissionId: admission.admissionId,
        outcome: 'rejected',
        reservationId: null,
        errorCode: 'INSUFFICIENT_INVENTORY',
        httpStatus: 409,
      });
      expect(await inspect(fx.eventId, admission.admissionEpoch, admission.admissionId)).toMatchObject({
        state: 'consumed',
        outcome: { kind: 'rejected', resourceId: null, code: 'INSUFFICIENT_INVENTORY' },
      });
      expect(await slots(redis, fx.eventId, admission.admissionEpoch)).toBe(0);
      await new ReservationService().expireReservation(held.body.id);
      expect((await fx.state()).available).toBe(1);
      // The same logical request keeps its stored rejection although a seat is free again.
      const replay = await reserve(late, admission);
      expect(replay.status).toBe(409);
      expect(replay.body.error).toEqual(rejected.body.error);
      expect(await fx.state()).toMatchObject({ available: 1, held: 0, reservations: 1, results: 2 });
    });

    it('retries one transient failure inside the request and resumes the same claim after exhaustion', async () => {
      fx = await fixture();
      const [first, second] = fx.users;
      // Fault injection: only the listed inventory calls fail; PostgreSQL, Redis and HTTP are real.
      const adjust = jest.spyOn(InventoryService.prototype, 'adjustAvailableSeats');
      adjust.mockRejectedValueOnce(pgError('40001'));
      const retried = await reserve(first, await admit(service, fx.eventId, first));
      expect(retried.status).toBe(201);
      expect(adjust).toHaveBeenCalledTimes(2);

      const admission = await admit(service, fx.eventId, second);
      for (const code of ['40001', '40P01', '40001']) adjust.mockRejectedValueOnce(pgError(code));
      const exhausted = await reserve(second, admission);
      expect(exhausted.status).toBe(503);
      expect(exhausted.body).toEqual(admissionError('ADMISSION_UNAVAILABLE', 1000));
      expect(await fx.state()).toMatchObject({ available: 19, reservations: 1, results: 1 });
      // The claim is neither stored as a business rejection nor returned: the slot stays in use.
      const claimed = await inspect(fx.eventId, admission.admissionEpoch, admission.admissionId);
      expect(claimed).toMatchObject({ state: 'admitted', phase: 'processing' });
      expect(await slots(redis, fx.eventId, admission.admissionEpoch)).toBe(1);
      const resumed = await reserve(second, admission);
      expect(resumed.status).toBe(201);
      expect(await fx.state()).toMatchObject({ available: 18, reservations: 2, results: 2 });
      expect(await slots(redis, fx.eventId, admission.admissionEpoch)).toBe(0);
    });

    it('answers 503 without a second PostgreSQL connection when the Redis control is missing', async () => {
      fx = await fixture();
      const [user] = fx.users,
        admission = await admit(service, fx.eventId, user);
      // Synthetic loss of the control key only; the purchase must not re-read policy elsewhere.
      await redis.del(admissionKeys(fx.eventId, admission.admissionEpoch)[0]);
      const connect = jest.spyOn(pool, 'connect');
      const response = await reserve(user, admission);
      expect(response.status).toBe(503);
      expect(response.body).toEqual(admissionError('ADMISSION_RECOVERING', 1000));
      expect(connect).toHaveBeenCalledTimes(1);
      expect(await fx.state()).toMatchObject({ available: 20, reservations: 0, results: 0 });
    });

    it('keeps unprotected reservations on the existing flow with or without admission fields', async () => {
      fx = await fixture(3, false);
      const [user] = fx.users;
      const ignored = { admissionId: randomUUID(), admissionEpoch: randomUUID() };
      expect((await reserve(user)).status).toBe(201);
      expect((await reserve(user, ignored)).status).toBe(201);
      // No retry key exists without protection: the same body holds another seat, as before.
      expect((await reserve(user, ignored)).status).toBe(201);
      expect(await fx.state()).toMatchObject({ available: 0, held: 3, reservations: 3, results: 0 });
    });

    it('lets concurrent unprotected reservations wait for the event row instead of failing serialization', async () => {
      fx = await fixture(3, false);
      const [user] = fx.users;
      const responses = await Promise.all(Array.from({ length: 5 }, () => reserve(user)));
      expect(responses.map((r) => r.status).sort()).toEqual([201, 201, 201, 409, 409]);
      for (const response of responses.filter((r) => r.status === 409))
        expect(response.body.error.code).toBe('INSUFFICIENT_INVENTORY');
      expect(await fx.state()).toMatchObject({ available: 0, held: 3, reservations: 3 });
    });

    it('keeps the existing 404 for a missing event with and without admission fields', async () => {
      fx = await fixture();
      const [user] = fx.users,
        missing = { eventId: randomUUID() };
      for (const fields of [{}, { admissionId: randomUUID(), admissionEpoch: randomUUID() }]) {
        const response = await reserve(user, fields, missing);
        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
      }
    });
  });
});
