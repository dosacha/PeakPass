import 'dotenv/config';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { once } from 'events';
import http from 'http';
import type { PoolClient } from 'pg';
import { initRedis, closeRedis } from '@/infra/redis/client';
import * as commands from '@/infra/redis/commands';
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';
import * as policy from '@/infra/postgres/admission-policy';
import { readAdmissionPolicy, lockAdmission } from '@/infra/postgres/admission-policy';
import { getConfig } from '@/infra/config';
import { initLogger } from '@/infra/logger';
import { admissionKeys } from '@/infra/redis/admission';
import { InternalServerError } from '@/core/errors';
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
  sleep,
  TIER,
  Json,
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
    return { status: response.status, body: (await response.json()) as Json };
  }
  const reserve = (userId: string, admission: Partial<Admission> = {}, changes: object = {}) =>
    request(
      'POST',
      '/reservations',
      { eventId: fx.eventId, userId, tierId: TIER, quantity: 1, ...admission, ...changes },
      { authorization: fx.token(userId) },
    );
  const cancel = (userId: string, admission: Admission) =>
    request(
      'DELETE',
      `/events/${fx.eventId}/admissions/${admission.admissionId}`,
      { epoch: admission.admissionEpoch },
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
      expect(Object.keys(response.body).sort()).toEqual([
        'createdAt',
        'eventId',
        'expiresAt',
        'id',
        'quantity',
        'status',
        'tierId',
        'updatedAt',
        'userId',
      ]);
      expect(response.body).toMatchObject({ userId: user, eventId: fx.eventId, status: 'active' });
      expect(await fx.state()).toMatchObject({
        available: 19,
        held: 1,
        reservations: 1,
        results: 1,
      });
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
      expect(
        await inspect(fx.eventId, admission.admissionEpoch, admission.admissionId),
      ).toMatchObject({
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
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => reserve(second, racing)),
      );
      // Every answer is the one reservation. Only on a host slow enough to exceed lock_timeout may
      // a request instead be told that the same request is in progress, which it may retry.
      const created201 = responses.filter((r) => r.status === 201);
      expect(created201.length).toBeGreaterThan(0);
      expect(new Set(created201.map((r) => r.body.id)).size).toBe(1);
      for (const response of responses.filter((r) => r.status !== 201)) {
        expect(response.status).toBe(409);
        expect(response.body).toEqual(admissionError('ADMISSION_IN_PROGRESS'));
      }
      expect((await reserve(second, racing)).body.id).toBe(created201[0].body.id);
      expect(await fx.state()).toMatchObject({
        available: 18,
        held: 2,
        reservations: 2,
        results: 2,
      });
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
        [
          waitingUser,
          { admissionId: waiting.admissionId, admissionEpoch: epoch },
          409,
          'ADMISSION_NOT_READY',
        ],
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

    it('lets either the cancel or the purchase win an admission, never both', async () => {
      fx = await fixture(20, true, 5);
      let purchased = 0;
      for (const user of fx.users) {
        const admission = await admit(service, fx.eventId, user);
        const [cancelled, purchase] = await Promise.all([
          cancel(user, admission),
          reserve(user, admission),
        ]);
        if (purchase.status === 201) {
          purchased++;
          // The claim or its result was first: the cancel is refused and nothing is undone.
          expect(cancelled.status).toBe(409);
          expect(cancelled.body.error.code).toMatch(/^ADMISSION_(IN_PROGRESS|ALREADY_CONSUMED)$/);
        } else {
          expect(cancelled.status).toBe(200);
          expect(purchase.status).toBe(410);
          expect(purchase.body).toEqual(admissionError('ADMISSION_CANCELLED'));
        }
      }
      expect(await fx.state()).toMatchObject({
        available: 20 - purchased,
        reservations: purchased,
        results: purchased,
      });
    });

    it('refuses a cancel once the purchase holds the claim, and the purchase still commits', async () => {
      fx = await fixture();
      const [user] = fx.users,
        admission = await admit(service, fx.eventId, user);
      // Injected pause only: the purchase is held right after Redis approved its claim, inside its
      // transaction. Unforced, the race above goes to the cancel, which never waits on PostgreSQL.
      let resume!: () => void;
      const held = new Promise<void>((resolve) => (resume = resolve));
      let reached!: () => void;
      const claimed = new Promise<void>((resolve) => (reached = resolve));
      const claim = service.claim.bind(service);
      jest.spyOn(service, 'claim').mockImplementationOnce(async (input) => {
        const approved = await claim(input);
        reached();
        await held;
        return approved;
      });
      const purchase = reserve(user, admission);
      await claimed;
      const during = await cancel(user, admission).finally(resume);
      expect(during.status).toBe(409);
      expect(during.body.error.code).toBe('ADMISSION_IN_PROGRESS');
      expect((await purchase).status).toBe(201);
      const after = await cancel(user, admission);
      expect(after.status).toBe(409);
      expect(after.body.error.code).toBe('ADMISSION_ALREADY_CONSUMED');
      expect(await fx.state()).toMatchObject({ available: 19, reservations: 1, results: 1 });
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
      expect(
        await inspect(fx.eventId, admission.admissionEpoch, admission.admissionId),
      ).toMatchObject({
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
      expect(await fx.state()).toMatchObject({
        available: 1,
        held: 0,
        reservations: 1,
        results: 2,
      });
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
      // A statement timeout is transient as well. A constraint violation and an application 5xx
      // are defects: they stay 500 instead of inviting retries, and none of them is stored.
      adjust.mockRejectedValueOnce(pgError('57014'));
      expect((await reserve(second, admission)).status).toBe(503);
      adjust.mockRejectedValueOnce(pgError('23514'));
      const defect = await reserve(second, admission);
      expect(defect.status).toBe(500);
      expect(defect.body.error.code).toBe('INTERNAL_ERROR');
      adjust.mockRejectedValueOnce(new InternalServerError('injected failure'));
      const failed = await reserve(second, admission);
      expect(failed.status).toBe(500);
      // The application's own error reaches the client; it is not turned into a stored rejection.
      expect(failed.body.error.message).toBe('injected failure');
      expect(await fx.state()).toMatchObject({ available: 19, reservations: 1, results: 1 });
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
      const acquire = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
      const busyAtConnect: number[] = [];
      jest.spyOn(pool, 'connect').mockImplementation(((...args: unknown[]) => {
        busyAtConnect.push(pool.totalCount - pool.idleCount);
        return acquire(...args);
      }) as never);
      const response = await reserve(user, admission);
      expect(response.status).toBe(503);
      expect(response.body).toEqual(admissionError('ADMISSION_RECOVERING', 1000));
      // The purchase transaction, then the ledger read that confirms the refusal after that
      // transaction ended: no connection is taken while another is checked out.
      expect(busyAtConnect).toEqual([0, 0]);
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
      expect(await fx.state()).toMatchObject({
        available: 0,
        held: 3,
        reservations: 3,
        results: 0,
      });
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
      expect(created.body).toMatchObject({
        order: { userId: user, status: 'pending' },
        tickets: [],
      });
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
      expect(
        await inspect(fx.eventId, admission.admissionEpoch, admission.admissionId),
      ).toMatchObject({
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
      // The same key with a changed payload keeps the existing idempotency answer and envelope.
      const changed = await checkout(user, key, admission, { quantity: 2 });
      expect(changed.status).toBe(409);
      expect(changed.body).toMatchObject({
        error: { code: 'CONFLICT' },
        requestId: expect.any(String),
      });
      expect(await fx.state()).toMatchObject({ available: 19, ordered: 1, orders: 1, results: 1 });
    });

    it('lets exactly one of a reservation and a direct checkout win the same admission', async () => {
      fx = await fixture(20, true, 5);
      for (const user of fx.users) {
        const admission = await admit(service, fx.eventId, user);
        const key = randomUUID();
        const responses = await Promise.all([
          reserve(user, admission),
          checkout(user, key, admission),
        ]);
        expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
        const lostReservation = responses[0].status === 409;
        // The loser is the other command. Only a host slow enough to exceed lock_timeout may tell
        // it "in progress" first; asked again, it is told that the admission was used differently.
        expect(responses[lostReservation ? 0 : 1].body.error.code).toMatch(
          /^ADMISSION_(REQUEST_MISMATCH|IN_PROGRESS)$/,
        );
        const again = lostReservation
          ? await reserve(user, admission)
          : await checkout(user, key, admission);
        expect(again.status).toBe(409);
        expect(again.body).toEqual(admissionError('ADMISSION_REQUEST_MISMATCH'));
      }
      const state = await fx.state();
      expect(state.reservations + state.orders).toBe(5);
      expect(state).toMatchObject({ available: 15, results: 5 });
      expect(new Set((await fx.results()).map((r) => r.admissionId)).size).toBe(5);
    });

    it('stores a sold-out direct checkout as one rejection without a partial order', async () => {
      fx = await fixture(1);
      const [buyer, late] = fx.users;
      expect(
        (await checkout(buyer, randomUUID(), await admit(service, fx.eventId, buyer))).status,
      ).toBe(201);
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
        (await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE user_id=$1', [late])).rows[0]
          .n,
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
      const wrong = await checkout(
        user,
        key,
        { ...admission, admissionId: randomUUID() },
        conversion,
      );
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
        {
          orderId: converted.body.order.id,
          providerTransactionId: randomUUID(),
          status: 'settled',
        },
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
      expect(
        await inspect(fx.eventId, admission.admissionEpoch, admission.admissionId),
      ).toMatchObject({
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
        JSON.stringify({
          eventId: fx.eventId,
          userId: user,
          tierId: TIER,
          quantity: 1,
          ...admission,
        }),
      );
      await occupying;
      lost.destroy();
      expect(await until(async () => (await fx.state()).results === 1)).toBe(true);
      const replay = await reserve(user, admission);
      expect(replay.status).toBe(201);
      expect((await fx.results())[0].reservationId).toBe(replay.body.id);
      expect(await fx.state()).toMatchObject({
        available: 19,
        held: 1,
        reservations: 1,
        results: 1,
      });
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

  describe('policy states and transitions', () => {
    it('answers 503 while recovering and 410 for a retired epoch, and still replays a committed result', async () => {
      fx = await fixture();
      const [done, pending, fresh] = fx.users;
      const consumed = await admit(service, fx.eventId, done);
      const reservation = await reserve(done, consumed);
      expect(reservation.status).toBe(201);
      const waiting = await admit(service, fx.eventId, pending);
      // Reset step 1 (real freeze): Redis stops approving claims before PostgreSQL moves on.
      const control = (await service.control(fx.eventId))!;
      await service.freeze(fx.eventId, control);
      const frozen = await reserve(pending, waiting);
      expect(frozen.status).toBe(503);
      expect(frozen.body).toEqual(admissionError('ADMISSION_RECOVERING', 1000));
      // The reset completes: PostgreSQL has left the epoch for good.
      await service.recover(fx.eventId, control);
      const current = (await service.control(fx.eventId))!;
      expect(current.epoch).not.toBe(control.epoch);
      const retired = await reserve(pending, waiting);
      expect(retired.status).toBe(410);
      expect(retired.body).toEqual(admissionError('ADMISSION_RESET'));
      const replay = await reserve(done, consumed);
      expect(replay.status).toBe(201);
      expect(replay.body.id).toBe(reservation.body.id);
      // Synthetic PostgreSQL phase: recovering is written directly; the request path is real.
      await pool.query("UPDATE admission_events SET phase='recovering' WHERE event_id=$1", [
        fx.eventId,
      ]);
      const recovering = await reserve(fresh, {
        admissionId: randomUUID(),
        admissionEpoch: current.epoch,
      });
      expect(recovering.status).toBe(503);
      expect(recovering.body).toEqual(admissionError('ADMISSION_RECOVERING', 1000));
      expect(await fx.state()).toMatchObject({ available: 19, reservations: 1, results: 1 });
    });

    it('fences an old epoch by the durable policy alone, while Redis still answers ready for it', async () => {
      fx = await fixture();
      const [user] = fx.users,
        admission = await admit(service, fx.eventId, user);
      // Synthetic barrier: PostgreSQL has left the epoch but Redis was not frozen or retired.
      await pool.query(
        'UPDATE admission_events SET generation=generation+1,epoch=$2 WHERE event_id=$1',
        [fx.eventId, randomUUID()],
      );
      const response = await reserve(user, admission);
      expect(response.status).toBe(410);
      expect(response.body).toEqual(admissionError('ADMISSION_RESET'));
      expect(
        await inspect(fx.eventId, admission.admissionEpoch, admission.admissionId),
      ).toMatchObject({
        state: 'admitted',
        phase: 'idle',
      });
      expect(await fx.state()).toMatchObject({ available: 20, reservations: 0, results: 0 });
    });

    it('rejects an unknown subject and an impossible tier before any claim', async () => {
      fx = await fixture();
      const [user] = fx.users,
        ghost = randomUUID();
      const ghostAdmission = await admit(service, fx.eventId, ghost);
      const unknown = await request(
        'POST',
        '/reservations',
        { eventId: fx.eventId, userId: ghost, tierId: TIER, quantity: 1, ...ghostAdmission },
        { authorization: fx.token(ghost) },
      );
      expect(unknown.status).toBe(401);
      expect(unknown.body).toEqual(admissionError('UNAUTHENTICATED'));
      const admission = await admit(service, fx.eventId, user);
      // Longer than the tier column, or carrying a NUL that the stored rejection text could not hold.
      for (const tierId of ['t'.repeat(51), 'vip\u0000']) {
        const impossible = await reserve(user, admission, { tierId });
        expect(impossible.status).toBe(400);
        expect(impossible.body).toEqual(admissionError('ADMISSION_INVALID_INPUT'));
      }
      // Neither request claimed: both admissions are untouched and no result exists.
      for (const a of [ghostAdmission, admission])
        expect(await inspect(fx.eventId, a.admissionEpoch, a.admissionId)).toMatchObject({
          state: 'admitted',
          phase: 'idle',
        });
      expect(await fx.state()).toMatchObject({ available: 20, reservations: 0, results: 0 });
      expect((await reserve(user, admission)).status).toBe(201);
    });

    it('bounds lock waits: 409 while the admission is locked, 503 while the event row is, then the same request succeeds', async () => {
      fx = await fixture();
      const [user] = fx.users,
        admission = await admit(service, fx.eventId, user);
      const holder = await pool.connect();
      try {
        // Another request for this admission is still inside its transaction (real lock).
        await holder.query('BEGIN');
        await lockAdmission(holder, admission.admissionId);
        const locked = await reserve(user, admission);
        expect(locked.status).toBe(409);
        expect(locked.body).toEqual(admissionError('ADMISSION_IN_PROGRESS'));
        await holder.query('ROLLBACK');
        // The event row stays locked past lock_timeout: a transient failure after the claim.
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM events WHERE id=$1 FOR UPDATE', [fx.eventId]);
        const delayed = await reserve(user, admission);
        expect(delayed.status).toBe(503);
        expect(delayed.body).toEqual(admissionError('ADMISSION_UNAVAILABLE', 1000));
        expect(
          await inspect(fx.eventId, admission.admissionEpoch, admission.admissionId),
        ).toMatchObject({
          state: 'admitted',
          phase: 'processing',
        });
        expect(await fx.state()).toMatchObject({ available: 20, reservations: 0, results: 0 });
        await holder.query('ROLLBACK');
        // An activation or reset holds the exclusive event gate: the very first wait of the
        // purchase is bounded as well, instead of keeping its connection until the gate opens.
        await holder.query('BEGIN');
        await readAdmissionPolicy(holder, fx.eventId, 'exclusive');
        const gated = reserve(user, admission);
        const answer = await Promise.race([gated, sleep(3000).then(() => 'still waiting')]);
        await holder.query('ROLLBACK');
        await gated;
        expect(answer).toMatchObject({
          status: 503,
          body: admissionError('ADMISSION_UNAVAILABLE', 1000),
        });
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
      expect((await reserve(user, admission)).status).toBe(201);
      expect(await fx.state()).toMatchObject({ available: 19, reservations: 1, results: 1 });
    });

    it('applies a protection that commits while both purchase paths wait for the event gate', async () => {
      fx = await fixture(20, false);
      const [user] = fx.users;
      const policyReads = jest.spyOn(policy, 'readAdmissionPolicy');
      const activation = await pool.connect();
      let pending: Array<ReturnType<typeof reserve>> = [];
      try {
        // The contract's activation: exclusive gate and a real UPDATE, not yet committed.
        await activation.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const pid = (await activation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await readAdmissionPolicy(activation, fx.eventId, 'exclusive');
        await activation.query('UPDATE admission_events SET protected=true WHERE event_id=$1', [
          fx.eventId,
        ]);
        policyReads.mockClear();
        pending = [reserve(user), checkout(user, randomUUID())];
        await blocked(pool, pid, 2);
        await activation.query('COMMIT');
        for (const response of await Promise.all(pending)) {
          expect(response.status).toBe(400);
          expect(response.body).toEqual(admissionError('ADMISSION_INVALID_INPUT'));
        }
        // READ COMMITTED reads the new policy after the wait; the SERIALIZABLE checkout fails
        // its stale snapshot and reads again in a new transaction.
        expect(policyReads).toHaveBeenCalledTimes(3);
        expect(await fx.state()).toMatchObject({ available: 20, reservations: 0, orders: 0 });
      } finally {
        await activation.query('ROLLBACK').catch(() => undefined);
        activation.release();
        await Promise.allSettled(pending);
      }
    });

    it('answers 404 when an admission consumed for another event is sent here', async () => {
      fx = await fixture();
      const [user] = fx.users,
        admission = await admit(service, fx.eventId, user);
      expect((await reserve(user, admission)).status).toBe(201);
      const other = await fixture(5, false);
      const response = await reserve(user, admission, { eventId: other.eventId });
      expect(response.status).toBe(404);
      expect(response.body).toEqual(admissionError('ADMISSION_NOT_FOUND'));
      expect(await other.state()).toMatchObject({ available: 5, reservations: 0, results: 0 });
    });

    it('keeps the limiter outage answer distinct from admission on an exempt reservation checkout', async () => {
      fx = await fixture();
      const [user] = fx.users,
        key = randomUUID();
      const reservation = await reserve(user, await admit(service, fx.eventId, user));
      expect(reservation.status).toBe(201);
      await redis.del(await redis.keys(`peakpass:admission:${fx.eventId}:*`));
      // Fault injection: the limiter reports Redis unavailable once (fail-closed is the default).
      jest
        .spyOn(commands, 'checkRateLimit')
        .mockResolvedValueOnce({ allowed: false, count: 0, resetAt: 0, redisAvailable: false });
      const conversion = { reservationId: reservation.body.id };
      const limited = await checkout(user, key, {}, conversion);
      expect(limited.status).toBe(503);
      expect(limited.body).toEqual({
        error: { code: 'RATE_LIMIT_UNAVAILABLE', message: expect.any(String) },
      });
      expect(await fx.state()).toMatchObject({ held: 1, orders: 0 });
      // Admission exemption is not limiter exemption; once the limiter answers, no queue is needed.
      expect((await checkout(user, key, {}, conversion)).status).toBe(201);
      expect(await fx.state()).toMatchObject({ available: 19, held: 0, ordered: 1, results: 1 });
    });

    it('replays an unlinked order whatever became of the submitted admission, and still refuses a new order with it', async () => {
      fx = await fixture(20, false);
      const [user, other] = fx.users,
        orderKey = randomUUID();
      const legacy = await checkout(user, orderKey);
      expect(legacy.status).toBe(201);
      await setProtected(fx.eventId, true);
      await service.recover(fx.eventId);
      // The user's own admission, consumed by a reservation, and another user's consumed admission.
      const own = await admit(service, fx.eventId, user);
      const foreign = await admit(service, fx.eventId, other);
      expect((await reserve(user, own)).status).toBe(201);
      expect((await reserve(other, foreign)).status).toBe(201);
      for (const fields of [own, foreign]) {
        const replay = await checkout(user, orderKey, fields);
        expect(replay.status).toBe(201);
        expect(replay.body.order.id).toBe(legacy.body.order.id);
      }
      const reused = await checkout(user, randomUUID(), own);
      expect(reused.status).toBe(409);
      expect(reused.body).toEqual(admissionError('ADMISSION_REQUEST_MISMATCH'));
      const stolen = await checkout(user, randomUUID(), foreign);
      expect(stolen.status).toBe(404);
      expect(stolen.body).toEqual(admissionError('ADMISSION_NOT_FOUND'));
      expect(await fx.state()).toMatchObject({ available: 17, held: 2, ordered: 1, results: 2 });
    });

    it('replays an existing order while another request holds the lock of the submitted admission', async () => {
      fx = await fixture(20, false);
      const [user] = fx.users,
        orderKey = randomUUID();
      const legacy = await checkout(user, orderKey);
      expect(legacy.status).toBe(201);
      await setProtected(fx.eventId, true);
      await service.recover(fx.eventId);
      const admission = await admit(service, fx.eventId, user);
      const holder = await pool.connect();
      try {
        // Another request for this admission is still inside its transaction (real lock).
        await holder.query('BEGIN');
        await lockAdmission(holder, admission.admissionId);
        const replay = await checkout(user, orderKey, admission);
        expect(replay.status).toBe(201);
        expect(replay.body.order.id).toBe(legacy.body.order.id);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
      expect(await fx.state()).toMatchObject({ available: 19, ordered: 1, results: 0 });
    });

    it('answers a stranger the existing reservation conflict whether or not that reservation has an admission link', async () => {
      fx = await fixture(20, false);
      const [owner, stranger] = fx.users;
      const unlinked = await reserve(owner);
      await setProtected(fx.eventId, true);
      await service.recover(fx.eventId);
      const linked = await reserve(owner, await admit(service, fx.eventId, owner));
      expect([unlinked.status, linked.status]).toEqual([201, 201]);
      const guess = { admissionId: randomUUID(), admissionEpoch: randomUUID() };
      for (const reservation of [unlinked, linked]) {
        const response = await checkout(stranger, randomUUID(), guess, {
          reservationId: reservation.body.id,
        });
        expect(response.status).toBe(409);
        expect(response.body.error).toMatchObject({
          code: 'CONFLICT',
          message: 'Checkout payload does not match reservation',
        });
      }
      expect(await fx.state()).toMatchObject({ available: 18, held: 2, orders: 0, results: 1 });
    });

    it('answers 503 and stays alive when PostgreSQL ends the session while the purchase waits on Redis', async () => {
      fx = await fixture();
      const [user] = fx.users,
        admission = await admit(service, fx.eventId, user);
      const claim = service.claim.bind(service);
      jest.spyOn(service, 'claim').mockImplementationOnce(async (input) => {
        // The purchase session is idle between two queries, as it is while Redis is slow. The
        // server ends it for real: the same FATAL that the idle-in-transaction bound produces.
        const idle = await pool.query(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND state='idle in transaction' AND query LIKE 'SELECT 1 FROM users%'`,
        );
        expect(idle.rows).toHaveLength(1);
        await pool.query('SELECT pg_terminate_backend($1)', [idle.rows[0].pid]);
        await sleep(200);
        return claim(input);
      });
      const response = await reserve(user, admission);
      expect(response.status).toBe(503);
      expect(response.body).toEqual(admissionError('ADMISSION_UNAVAILABLE', 1000));
      expect(await fx.state()).toMatchObject({ available: 20, reservations: 0, results: 0 });
      // The claim was approved; the same request continues it on a new connection.
      expect((await reserve(user, admission)).status).toBe(201);
      expect(await fx.state()).toMatchObject({ available: 19, reservations: 1, results: 1 });
    });

    it('answers 503 when an admission purchase cannot obtain a connection, and the existing 500 without admission', async () => {
      fx = await fixture();
      const [user] = fx.users,
        admission = await admit(service, fx.eventId, user);
      // Fault injection: pg-pool's acquire timeout, an error without a code.
      const exhausted = () => new Error('timeout exceeded when trying to connect');
      const connect = jest.spyOn(pool, 'connect');
      connect.mockRejectedValueOnce(exhausted() as never);
      const refused = await reserve(user, admission);
      expect(refused.status).toBe(503);
      expect(refused.body).toEqual(admissionError('ADMISSION_UNAVAILABLE', 1000));
      connect.mockRejectedValueOnce(exhausted() as never);
      expect((await reserve(user)).status).toBe(500);
      connect.mockRestore();
      expect((await reserve(user, admission)).status).toBe(201);
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
        if (kind === 'consumed') expect(replay.body.id).toBe(response.body.id);
        else {
          expect(response.body.error.code).toBe('INSUFFICIENT_INVENTORY');
          expect(replay.body.error).toEqual(response.body.error);
        }
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

    it('leaves a claim of an epoch that PostgreSQL has already left to the reset instead of closing it', async () => {
      fx = await fixture();
      const [user] = fx.users,
        admission = await admit(service, fx.eventId, user);
      await service.claim(claimOf(user, admission));
      await pastDeadline(admission);
      // Synthetic barrier commit: the durable epoch moved on while Redis still holds the claim.
      await pool.query(
        'UPDATE admission_events SET generation=generation+1,epoch=$2 WHERE event_id=$1',
        [fx.eventId, randomUUID()],
      );
      await reclaimOverdueClaims(fx.eventId, await overdue());
      expect((await fx.state()).results).toBe(0);
      expect(await slots(redis, fx.eventId, admission.admissionEpoch)).toBe(1);
    });

    it('lets a stale snapshot occupy again only up to the ledger insert, then replays the committed rejection', async () => {
      fx = await fixture(1);
      const [buyer, user] = fx.users;
      expect((await reserve(buyer, await admit(service, fx.eventId, buyer))).status).toBe(201);
      const admission = await admit(service, fx.eventId, user);
      // Injected pauses only: the first request is held at its claim, inside its transaction and
      // holding the admission lock, and later between its COMMIT and its Redis finalization, so
      // Redis still approves the same claim. PostgreSQL locks, snapshots and commits are real.
      let resume!: () => void;
      const held = new Promise<void>((resolve) => (resume = resolve));
      let reached!: () => void;
      const claiming = new Promise<void>((resolve) => (reached = resolve));
      const claim = service.claim.bind(service);
      const claims = jest.spyOn(service, 'claim').mockImplementationOnce(async (input) => {
        reached();
        await held;
        return claim(input);
      });
      let finalize!: () => void;
      const unreflected = new Promise<void>((resolve) => (finalize = resolve));
      const complete = service.complete.bind(service);
      jest.spyOn(service, 'complete').mockImplementationOnce(async (...args) => {
        await unreflected;
        return complete(...args);
      });
      const first = reserve(user, admission);
      await claiming;
      const holder = (
        await pool.query(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND state='idle in transaction' AND query LIKE 'SELECT 1 FROM users%'`,
        )
      ).rows[0].pid;
      // The second request takes its SERIALIZABLE snapshot now and waits for the admission lock.
      const second = reserve(user, admission);
      await blocked(pool, holder);
      resume();
      // Its snapshot could not see the committed rejection, Redis approved the same claim again,
      // and it ran the occupation a second time. The ledger insert stopped it: this transaction
      // had read the key, so PostgreSQL reports the committed row as a serialization failure
      // (40001) rather than a duplicate key. A fresh transaction then replayed the stored result.
      // The first request is released in every case, so a failure here cannot leave it parked.
      const late = await second.finally(finalize);
      expect(claims).toHaveBeenCalledTimes(2);
      const responses = [await first, late];
      expect(await slots(redis, fx.eventId, admission.admissionEpoch)).toBe(0);
      for (const response of responses) {
        expect(response.status).toBe(409);
        expect(response.body.error).toEqual(responses[0].body.error);
        expect(response.body.error.code).toBe('INSUFFICIENT_INVENTORY');
      }
      expect((await fx.results()).filter((r) => r.admissionId === admission.admissionId)).toEqual([
        expect.objectContaining({ outcome: 'rejected', errorCode: 'INSUFFICIENT_INVENTORY' }),
      ]);
      expect(await fx.state()).toMatchObject({
        available: 0,
        held: 1,
        reservations: 1,
        results: 2,
      });
    });

    it('replays the committed result when Redis refuses the claim of a request whose snapshot predates it', async () => {
      fx = await fixture();
      const [user] = fx.users,
        admission = await admit(service, fx.eventId, user);
      // Injected: the first request is held at its claim, inside its transaction and holding the
      // admission lock; its Redis finalization is lost, after which this instance refuses claims
      // until it re-verifies Redis; the second request's claim is held until that loss.
      // PostgreSQL locks, snapshots and commits are real.
      let resume!: () => void;
      const held = new Promise<void>((resolve) => (resume = resolve));
      let reached!: () => void;
      const claiming = new Promise<void>((resolve) => (reached = resolve));
      let lose!: () => void;
      const lost = new Promise<void>((resolve) => (lose = resolve));
      const claim = service.claim.bind(service);
      const claims = jest
        .spyOn(service, 'claim')
        .mockImplementationOnce(async (input) => {
          reached();
          await held;
          return claim(input);
        })
        .mockImplementationOnce(async (input) => {
          await lost;
          return claim(input);
        });
      const complete = service.complete.bind(service);
      jest.spyOn(service, 'complete').mockImplementationOnce(async (...args) => {
        try {
          return await complete(...args);
        } finally {
          lose();
        }
      });
      const evaluate = redis.eval.bind(redis) as (...args: unknown[]) => Promise<unknown>;
      jest
        .spyOn(redis, 'eval')
        .mockImplementation(((script: string, options: { arguments: string[] }) =>
          options.arguments[0] === 'complete'
            ? Promise.reject(new Error('Socket closed unexpectedly'))
            : evaluate(script, options)) as never);
      try {
        const first = reserve(user, admission);
        await claiming;
        const holder = (
          await pool.query(
            `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
            AND state='idle in transaction' AND query LIKE 'SELECT 1 FROM users%'`,
          )
        ).rows[0].pid;
        // The second request takes its SERIALIZABLE snapshot now and waits for the admission lock.
        const second = reserve(user, admission);
        await blocked(pool, holder);
        resume();
        const responses = [await first, await second.finally(lose)];
        // The refusal was decided on a snapshot that could not see the committed reservation. It is
        // not the answer: the result is read again in a fresh transaction and replayed.
        expect(claims).toHaveBeenCalledTimes(2);
        for (const response of responses) {
          expect(response.status).toBe(201);
          expect(response.body.id).toBe(responses[0].body.id);
        }
        expect(await slots(redis, fx.eventId, admission.admissionEpoch)).toBe(1);
        expect(await fx.state()).toMatchObject({ available: 19, reservations: 1, results: 1 });
      } finally {
        resume();
        lose();
        await service.verifyEnvironment();
      }
    });

    it('keeps a late request that waited behind the reclaimer from occupying after the closed commit', async () => {
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
