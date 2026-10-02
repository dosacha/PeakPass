import 'dotenv/config';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { once } from 'events';
import http from 'http';
import type { PoolClient } from 'pg';
import { initRedis, closeRedis } from '@/infra/redis/client';
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';
import { readAdmissionPolicy, lockAdmission } from '@/infra/postgres/admission-policy';
import { getConfig } from '@/infra/config';
import { initLogger } from '@/infra/logger';
import { admissionKeys } from '@/infra/redis/admission';
import { InventoryService } from '@/core/services/inventory.service';
import { ReservationService } from '@/core/services/reservation.service';
import {
  admissionFingerprint,
  purchaseCommand,
  reclaimOverdueClaims,
} from '@/core/services/admission-consumption';
import { blocked, until } from './order-sweeper-fixture';
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

  async function fixture(seats = 20, isProtected = true, userCount = 3) {
    const created = await purchaseFixture(pool, getConfig().JWT_SECRET, seats, userCount);
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
  const checkout = (
    userId: string,
    key: string,
    admission: Partial<Admission> = {},
    changes: object = {},
  ) =>
    request(
      'POST',
      '/checkouts',
      { eventId: fx.eventId, userId, tierId: TIER, quantity: 1, ...admission, ...changes },
      { authorization: fx.token(userId), 'idempotency-key': key },
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

  describe('reservation-free checkout and existing purchases', () => {
    it('consumes an admission for a direct checkout, replays by key and refuses another key', async () => {
      fx = await fixture();
      const [user] = fx.users,
        key = randomUUID(),
        admission = await admit(service, fx.eventId, user);
      const missing = await checkout(user, randomUUID());
      expect(missing.status).toBe(400);
      expect(missing.body).toEqual(admissionError('ADMISSION_INVALID_INPUT'));
      const created = await checkout(user, key, admission);
      expect(created.status).toBe(201);
      // The success body keeps the existing order schema; nothing of the claim leaks into it.
      expect(Object.keys(created.body).sort()).toEqual(['order', 'tickets']);
      expect(created.body).toMatchObject({ order: { userId: user, status: 'pending' }, tickets: [] });
      expect(await fx.results()).toEqual([
        expect.objectContaining({
          admissionId: admission.admissionId,
          operation: 'direct-checkout',
          outcome: 'consumed',
          orderId: created.body.order.id,
          reservationId: null,
          fingerprint: JSON.stringify([
            user,
            fx.eventId,
            admission.admissionEpoch,
            'direct-checkout',
            TIER,
            1,
            key,
          ]),
        }),
      ]);
      expect(await inspect(fx.eventId, admission.admissionEpoch, admission.admissionId)).toMatchObject({
        state: 'consumed',
        outcome: { kind: 'direct-checkout', resourceId: created.body.order.id, code: null },
      });
      // The order replays by its key, with the admission fields or without them.
      for (const fields of [admission, {}]) {
        const replay = await checkout(user, key, fields);
        expect(replay.status).toBe(201);
        expect(replay.body.order.id).toBe(created.body.order.id);
      }
      const otherKey = await checkout(user, randomUUID(), admission);
      expect(otherKey.status).toBe(409);
      expect(otherKey.body).toEqual(admissionError('ADMISSION_REQUEST_MISMATCH'));
      expect(await fx.state()).toMatchObject({ available: 19, ordered: 1, orders: 1, results: 1 });
    });

    it('lets exactly one of a reservation and a direct checkout win the same admission', async () => {
      fx = await fixture(20, true, 5);
      for (const user of fx.users) {
        const admission = await admit(service, fx.eventId, user);
        const responses = await Promise.all([
          reserve(user, admission),
          checkout(user, randomUUID(), admission),
        ]);
        expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(responses.find((r) => r.status === 409)!.body).toEqual(
          admissionError('ADMISSION_REQUEST_MISMATCH'),
        );
      }
      const state = await fx.state();
      expect(state.reservations + state.orders).toBe(5);
      expect(state).toMatchObject({ available: 15, results: 5 });
      expect(new Set((await fx.results()).map((r) => r.admissionId)).size).toBe(5);
    });

    it('stores a sold-out direct checkout as one rejection without a partial order', async () => {
      fx = await fixture(1);
      const [buyer, late] = fx.users;
      expect((await checkout(buyer, randomUUID(), await admit(service, fx.eventId, buyer))).status).toBe(201);
      const key = randomUUID(),
        admission = await admit(service, fx.eventId, late);
      const rejected = await checkout(late, key, admission);
      expect(rejected.status).toBe(409);
      expect(rejected.body.error.code).toBe('INSUFFICIENT_INVENTORY');
      const replay = await checkout(late, key, admission);
      expect(replay.status).toBe(409);
      expect(replay.body.error).toEqual(rejected.body.error);
      expect(await fx.state()).toMatchObject({ available: 0, ordered: 1, orders: 1, results: 2 });
      expect(
        (await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE user_id=$1', [late])).rows[0].n,
      ).toBe(0);
      expect(
        (
          await pool.query(
            `SELECT COUNT(*)::int AS n FROM payment_records p JOIN orders o ON o.id=p.order_id
            WHERE o.event_id=$1`,
            [fx.eventId],
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it('keeps an existing reservation checkout, its order replay and its payment exempt after reset', async () => {
      fx = await fixture();
      const [user] = fx.users,
        key = randomUUID(),
        admission = await admit(service, fx.eventId, user);
      const reservation = await reserve(user, admission);
      expect(reservation.status).toBe(201);
      // A real reset leaves the consumed epoch for good, then the whole namespace is removed
      // (synthetic loss): the purchase that already exists in PostgreSQL must not queue again.
      await service.recover(fx.eventId, (await service.control(fx.eventId))!);
      expect((await service.control(fx.eventId))!.epoch).not.toBe(admission.admissionEpoch);
      await redis.del(await redis.keys(`peakpass:admission:${fx.eventId}:*`));
      const conversion = { reservationId: reservation.body.id };
      const wrong = await checkout(user, key, { ...admission, admissionId: randomUUID() }, conversion);
      expect(wrong.status).toBe(409);
      expect(wrong.body).toEqual(admissionError('ADMISSION_REQUEST_MISMATCH'));
      expect(await fx.state()).toMatchObject({ held: 1, orders: 0 });
      const converted = await checkout(user, key, {}, conversion);
      expect(converted.status).toBe(201);
      expect(converted.body.order.reservationId).toBe(reservation.body.id);
      for (const fields of [{}, admission]) {
        const replay = await checkout(user, key, fields, conversion);
        expect(replay.status).toBe(201);
        expect(replay.body.order.id).toBe(converted.body.order.id);
      }
      const staleEpoch = await checkout(
        user,
        key,
        { ...admission, admissionEpoch: randomUUID() },
        conversion,
      );
      expect(staleEpoch.status).toBe(409);
      const settled = await request(
        'POST',
        '/webhooks/payments/settlement',
        { orderId: converted.body.order.id, providerTransactionId: randomUUID(), status: 'settled' },
        { 'idempotency-key': randomUUID() },
      );
      expect(settled.status).toBe(200);
      expect(settled.body).toMatchObject({ order: { status: 'paid' }, paymentStatus: 'settled' });
      expect(settled.body.tickets).toHaveLength(1);
      expect(await fx.state()).toMatchObject({ available: 19, held: 0, ordered: 1, results: 1 });
    });

    it('leaves a reservation and an order from before protection unbound when admission fields arrive', async () => {
      fx = await fixture(20, false);
      const [user] = fx.users,
        orderKey = randomUUID();
      const legacyReservation = await reserve(user);
      const legacyOrder = await checkout(user, orderKey);
      expect([legacyReservation.status, legacyOrder.status]).toEqual([201, 201]);
      await setProtected(fx.eventId, true);
      await service.recover(fx.eventId);
      const admission = await admit(service, fx.eventId, user);
      const converted = await checkout(user, randomUUID(), admission, {
        reservationId: legacyReservation.body.id,
      });
      expect(converted.status).toBe(201);
      const replay = await checkout(user, orderKey, admission);
      expect(replay.status).toBe(201);
      expect(replay.body.order.id).toBe(legacyOrder.body.order.id);
      // Neither request bound or consumed the admission: it still buys one new reservation.
      expect((await fx.state()).results).toBe(0);
      expect(await inspect(fx.eventId, admission.admissionEpoch, admission.admissionId)).toMatchObject({
        state: 'admitted',
        phase: 'idle',
      });
      expect((await reserve(user, admission)).status).toBe(201);
      expect(await fx.state()).toMatchObject({ available: 17, held: 1, ordered: 2, results: 1 });
    });

    it('replays the committed reservation after the client connection is lost before the response', async () => {
      fx = await fixture();
      const [user] = fx.users,
        admission = await admit(service, fx.eventId, user);
      // The request reaches the occupation, then the client destroys its socket: the first
      // response is never delivered. A real TCP close on loopback, not a network partition.
      const create = ReservationService.prototype.createReservationWithClient;
      const occupying = new Promise<void>((resolve) => {
        jest
          .spyOn(ReservationService.prototype, 'createReservationWithClient')
          .mockImplementationOnce(function (this: ReservationService, ...args) {
            resolve();
            return create.apply(this, args);
          });
      });
      const lost = http.request(`${base}/reservations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: fx.token(user) },
      });
      lost.on('error', () => undefined);
      lost.end(
        JSON.stringify({ eventId: fx.eventId, userId: user, tierId: TIER, quantity: 1, ...admission }),
      );
      await occupying;
      lost.destroy();
      expect(await until(async () => (await fx.state()).results === 1)).toBe(true);
      const replay = await reserve(user, admission);
      expect(replay.status).toBe(201);
      expect((await fx.results())[0].reservationId).toBe(replay.body.id);
      expect(await fx.state()).toMatchObject({ available: 19, held: 1, reservations: 1, results: 1 });
    });

    it('keeps unprotected direct checkout and its replay unchanged', async () => {
      fx = await fixture(5, false);
      const [user] = fx.users,
        key = randomUUID();
      const created = await checkout(user, key);
      expect(created.status).toBe(201);
      expect((await checkout(user, key)).body.order.id).toBe(created.body.order.id);
      const ignored = { admissionId: randomUUID(), admissionEpoch: randomUUID() };
      expect((await checkout(user, randomUUID(), ignored)).status).toBe(201);
      const missing = await checkout(user, randomUUID(), {}, { eventId: randomUUID() });
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('NOT_FOUND');
      expect(await fx.state()).toMatchObject({ available: 3, ordered: 2, orders: 2, results: 0 });
    });
  });

  describe('Redis finalization and claim reclamation', () => {
    const fingerprintOf = (userId: string, admission: Admission) =>
      admissionFingerprint(
        purchaseCommand(
          'reservation',
          { userId, eventId: fx.eventId, tierId: TIER, quantity: 1 },
          null,
          { admissionId: admission.admissionId, epoch: admission.admissionEpoch },
        ),
      );
    const claimOf = (userId: string, admission: Admission) => ({
      eventId: fx.eventId,
      userId,
      admissionId: admission.admissionId,
      epoch: admission.admissionEpoch,
      fingerprint: fingerprintOf(userId, admission),
    });
    const overdue = async () => (await service.reconcile(fx.eventId)).claims ?? [];
    const pastDeadline = (admission: Admission) =>
      age(redis, fx.eventId, admission.admissionEpoch, admission.admissionId, { deadline: 1 });
    const closedResult = (userId: string, admission: Admission) => ({
      admissionId: admission.admissionId,
      userId,
      epoch: admission.admissionEpoch,
      operation: 'reservation',
      fingerprint: fingerprintOf(userId, admission),
      outcome: 'closed',
      reservationId: null,
      orderId: null,
      errorCode: 'ADMISSION_EXPIRED',
      httpStatus: 410,
      errorMessage: 'ADMISSION_EXPIRED',
    });

    it.each(['consumed', 'rejected'] as const)(
      'keeps the slot when Redis finalization of a %s result fails and returns it once through the reclaimer',
      async (kind) => {
        fx = await fixture(kind === 'rejected' ? 1 : 20);
        const [buyer, user] = fx.users;
        if (kind === 'rejected')
          expect((await reserve(buyer, await admit(service, fx.eventId, buyer))).status).toBe(201);
        const admission = await admit(service, fx.eventId, user);
        const { admissionEpoch: epoch, admissionId } = admission;
        // Fault injection: the first `complete` of this admission is lost. Every other command,
        // PostgreSQL transaction and HTTP exchange is real.
        const evaluate = redis.eval.bind(redis) as (...args: unknown[]) => Promise<unknown>;
        let lost = 0;
        jest.spyOn(redis, 'eval').mockImplementation(((
          script: string,
          options: { arguments: string[] },
        ) => {
          const [operation, , input] = options.arguments;
          if (operation === 'complete' && JSON.parse(input).admissionId === admissionId && !lost++)
            return Promise.reject(new Error('Socket closed unexpectedly'));
          return evaluate(script, options);
        }) as never);
        const response = await reserve(user, admission);
        expect(response.status).toBe(kind === 'consumed' ? 201 : 409);
        expect(lost).toBe(1);
        // The committed result is the answer. Redis still shows the claim, which keeps its slot.
        expect(await inspect(fx.eventId, epoch, admissionId)).toMatchObject({
          state: 'admitted',
          phase: 'processing',
          outcome: null,
        });
        expect(await slots(redis, fx.eventId, epoch)).toBe(1);
        const replay = await reserve(user, admission);
        expect(replay.status).toBe(response.status);
        expect(replay.body.id).toBe(response.body.id);
        expect(await slots(redis, fx.eventId, epoch)).toBe(1);
        // Synthetic deadline passage, then the real maintenance tick with the reclaimer.
        await pastDeadline(admission);
        await service.maintain(() => false, reclaimOverdueClaims);
        expect(await inspect(fx.eventId, epoch, admissionId)).toMatchObject({
          state: 'consumed',
          outcome:
            kind === 'consumed'
              ? { kind: 'reservation', resourceId: response.body.id, code: null }
              : { kind: 'rejected', resourceId: null, code: 'INSUFFICIENT_INVENTORY' },
        });
        expect(await slots(redis, fx.eventId, epoch)).toBe(0);
        await service.maintain(() => false, reclaimOverdueClaims);
        expect(await slots(redis, fx.eventId, epoch)).toBe(0);
        expect((await fx.state()).results).toBe(kind === 'consumed' ? 1 : 2);
      },
    );

    it('does not reclaim while a consumer holds the admission lock, closes after its rollback and fences the late writer', async () => {
      fx = await fixture();
      const [user] = fx.users,
        admission = await admit(service, fx.eventId, user),
        { admissionEpoch: epoch, admissionId } = admission;
      // A consumer that stalls after its claim, inside its transaction: real gate and lock.
      const consumer = await pool.connect();
      try {
        await consumer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await readAdmissionPolicy(consumer, fx.eventId);
        await lockAdmission(consumer, admissionId);
        await service.claim(claimOf(user, admission));
        await pastDeadline(admission);
        const claims = await overdue();
        expect(claims.map((c) => c.admissionId)).toEqual([admissionId]);
        await reclaimOverdueClaims(fx.eventId, claims);
        // No PostgreSQL lock, no reclamation: neither a closed row nor a returned slot.
        expect((await fx.state()).results).toBe(0);
        expect(await inspect(fx.eventId, epoch, admissionId)).toMatchObject({
          state: 'admitted',
          phase: 'reconciling',
        });
        expect(await slots(redis, fx.eventId, epoch)).toBe(1);
        await consumer.query('ROLLBACK');
      } finally {
        await consumer.query('ROLLBACK').catch(() => undefined);
        consumer.release();
      }
      const claims = await overdue();
      await reclaimOverdueClaims(fx.eventId, claims);
      expect(await fx.results()).toEqual([closedResult(user, admission)]);
      expect(await inspect(fx.eventId, epoch, admissionId)).toMatchObject({
        state: 'expired',
        reason: 'ADMISSION_EXPIRED',
      });
      expect(await slots(redis, fx.eventId, epoch)).toBe(0);
      // Repeating the same reclamation neither adds a row nor returns another slot.
      await reclaimOverdueClaims(fx.eventId, claims);
      expect(await slots(redis, fx.eventId, epoch)).toBe(0);
      const late = await reserve(user, admission);
      expect(late.status).toBe(410);
      expect(late.body).toEqual(admissionError('ADMISSION_EXPIRED'));
      const changed = await reserve(user, admission, { quantity: 2 });
      expect(changed.status).toBe(409);
      expect(changed.body).toEqual(admissionError('ADMISSION_REQUEST_MISMATCH'));
      expect(await fx.state()).toMatchObject({ available: 20, reservations: 0, results: 1 });
    });

    it('keeps a consumer whose snapshot predates the closed commit from occupying', async () => {
      fx = await fixture();
      const [user] = fx.users,
        admission = await admit(service, fx.eventId, user);
      // Fixture: an approved claim whose consumer never committed, now past its deadline.
      await service.claim(claimOf(user, admission));
      await pastDeadline(admission);
      const claims = await overdue();
      // The reclaimer is held before its COMMIT (injected pause on its own connection), with
      // the closed row written and the admission lock taken. Locks and commits are real.
      let resume!: () => void;
      const held = new Promise<void>((resolve) => (resume = resolve));
      const connect = pool.connect.bind(pool) as unknown as () => Promise<PoolClient>;
      const paused = new Promise<number>((reached) => {
        jest.spyOn(pool, 'connect').mockImplementationOnce((async () => {
          const client = await connect();
          const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          client.query = (async (...args: unknown[]) => {
            if (args[0] === 'COMMIT' || args[0] === 'ROLLBACK') {
              client.query = query as typeof client.query;
              const pid = (await query('SELECT pg_backend_pid() AS pid')) as {
                rows: { pid: number }[];
              };
              reached(pid.rows[0].pid);
              await held;
            }
            return query(...args);
          }) as typeof client.query;
          return client;
        }) as never);
      });
      const reclaiming = reclaimOverdueClaims(fx.eventId, claims);
      const reclaimerPid = await paused;
      // The late request takes its SERIALIZABLE snapshot now and waits for the admission lock.
      const late = reserve(user, admission);
      await blocked(pool, reclaimerPid);
      resume();
      await reclaiming;
      const response = await late;
      // Redis answers expired once the close is reflected, in progress just before it.
      expect([409, 410]).toContain(response.status);
      expect(response.body.error.code).toMatch(/^ADMISSION_(EXPIRED|IN_PROGRESS)$/);
      expect(await fx.results()).toEqual([closedResult(user, admission)]);
      expect(await fx.state()).toMatchObject({ available: 20, reservations: 0, results: 1 });
      const retry = await reserve(user, admission);
      expect(retry.status).toBe(410);
      expect(retry.body).toEqual(admissionError('ADMISSION_EXPIRED'));
      expect(await fx.state()).toMatchObject({ available: 20, reservations: 0, results: 1 });
    });

    it('returns the slot of a consumer process killed inside its transaction only after PostgreSQL releases its lock', async () => {
      fx = await fixture();
      const [user] = fx.users,
        admission = await admit(service, fx.eventId, user),
        { admissionEpoch: epoch, admissionId } = admission;
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/tests/integration/admission-consumer-fixture.ts',
          fx.eventId,
          user,
          admissionId,
          epoch,
          fingerprintOf(user, admission),
        ],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true },
      );
      try {
        expect((await once(child, 'message', { signal: AbortSignal.timeout(20000) }))[0]).toEqual({
          claimed: true,
        });
        await pastDeadline(admission);
        await reclaimOverdueClaims(fx.eventId, await overdue());
        expect((await fx.state()).results).toBe(0);
        expect(await slots(redis, fx.eventId, epoch)).toBe(1);
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
        // The server rolls the dead session back; only then can the reclaimer take the lock.
        expect(
          await until(async () => {
            await reclaimOverdueClaims(fx.eventId, await overdue());
            return (await fx.state()).results === 1;
          }),
        ).toBe(true);
        expect(await fx.results()).toEqual([closedResult(user, admission)]);
        expect(await slots(redis, fx.eventId, epoch)).toBe(0);
        const late = await reserve(user, admission);
        expect(late.status).toBe(410);
        expect(await fx.state()).toMatchObject({ available: 20, reservations: 0, results: 1 });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      }
    });
  });
});
