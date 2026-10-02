import 'dotenv/config';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { PurchaseFixture } from './admission-purchase-fixture';

// ENABLE_ADMISSION keeps its default (false): this instance has the feature off.
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
// The demo override trusts body.userId without a JWT; admission consumption must not.
process.env.ENFORCE_AUTH_USER_MATCH = 'false';
jest.setTimeout(60000);

describe('protected event on an instance with admission off (actual PG/Redis/HTTP)', () => {
  let pool: Pool;
  let redis: Awaited<ReturnType<typeof import('@/infra/redis/client').initRedis>>;
  let app: FastifyInstance;
  let helpers: typeof import('./admission-purchase-fixture');
  let fx: PurchaseFixture;
  let base = '';

  beforeAll(async () => {
    const config = (await import('@/infra/config')).loadConfig();
    expect(config.ENABLE_ADMISSION).toBe(false);
    (await import('@/infra/logger')).initLogger();
    pool = await (await import('@/infra/postgres/client')).initPostgresPool();
    redis = await (await import('@/infra/redis/client')).initRedis();
    helpers = await import('./admission-purchase-fixture');
    app = await (await import('@/api/app')).createApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  beforeEach(async () => {
    const secret = (await import('@/infra/config')).getConfig().JWT_SECRET;
    fx = await helpers.purchaseFixture(pool, secret, 10);
  });
  afterEach(async () => {
    try {
      await fx.verify();
    } finally {
      await fx.cleanup(redis);
    }
  });
  afterAll(async () => {
    await app?.close();
    await (await import('@/infra/redis/client')).closeRedis();
    await (await import('@/infra/postgres/client')).closePostgresPool();
  });

  async function post(path: string, userId: string, fields: object, headers: object = {}) {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: fx.token(userId), ...headers },
      body: JSON.stringify({
        eventId: fx.eventId,
        userId,
        tierId: helpers.TIER,
        quantity: 1,
        ...fields,
      }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }
  const reserve = (userId: string, fields: object = {}) => post('/reservations', userId, fields);
  const checkout = (userId: string, key: string, fields: object = {}) =>
    post('/checkouts', userId, fields, { 'idempotency-key': key });
  const unavailable = {
    error: { code: 'ADMISSION_UNAVAILABLE', message: expect.any(String) },
    nextPollAfterMs: 1000,
  };

  it('answers 503 for a protected new occupation on both paths and keeps existing purchases working', async () => {
    const [user] = fx.users,
      orderKey = randomUUID();
    const reservation = await reserve(user);
    const order = await checkout(user, orderKey);
    expect([reservation.status, order.status]).toEqual([201, 201]);
    await helpers.setProtected(fx.eventId, true);
    // ENV off is not a release: the durable policy still protects the event on this instance.
    const admission = { admissionId: randomUUID(), admissionEpoch: randomUUID() };
    for (const response of [
      await reserve(user, admission),
      await checkout(user, randomUUID(), admission),
    ]) {
      expect(response.status).toBe(503);
      expect(response.body).toEqual(unavailable);
    }
    for (const response of [await reserve(user), await checkout(user, randomUUID())]) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('ADMISSION_INVALID_INPUT');
    }
    expect(await fx.state()).toMatchObject({ available: 8, held: 1, ordered: 1, results: 0 });
    // What already exists in PostgreSQL proceeds with its existing checks.
    const converted = await checkout(user, randomUUID(), { reservationId: reservation.body.id });
    expect(converted.status).toBe(201);
    const replay = await checkout(user, orderKey);
    expect(replay.status).toBe(201);
    expect(replay.body.order.id).toBe(order.body.order.id);
    expect(await fx.state()).toMatchObject({ available: 8, held: 0, ordered: 2, results: 0 });
  });

  it('replays a committed admission result without Redis state or the feature flag', async () => {
    const [user] = fx.users,
      admissionId = randomUUID(),
      admissionEpoch = randomUUID();
    const reservation = await reserve(user);
    expect(reservation.status).toBe(201);
    // Synthetic ledger row: the result an enabled instance committed for this reservation.
    await pool.query(
      `INSERT INTO admission_results
        (admission_id,user_id,event_id,epoch,operation,fingerprint,outcome,reservation_id)
      VALUES($1,$2,$3,$4,'reservation',$5,'consumed',$6)`,
      [
        admissionId,
        user,
        fx.eventId,
        admissionEpoch,
        JSON.stringify([user, fx.eventId, admissionEpoch, 'reservation', helpers.TIER, 1, null]),
        reservation.body.id,
      ],
    );
    await helpers.setProtected(fx.eventId, true);
    const replay = await reserve(user, { admissionId, admissionEpoch });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(reservation.body.id);
    const changed = await reserve(user, { admissionId, admissionEpoch, quantity: 2 });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('ADMISSION_REQUEST_MISMATCH');
    expect(await fx.state()).toMatchObject({ available: 9, held: 1, reservations: 1, results: 1 });
  });

  it('requires the JWT subject for admission fields even where the demo override trusts body.userId', async () => {
    const [user] = fx.users;
    const anonymous = (fields: object) =>
      post('/reservations', user, fields, { authorization: '' });
    expect((await anonymous({})).status).toBe(201);
    const response = await anonymous({ admissionId: randomUUID(), admissionEpoch: randomUUID() });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: expect.any(String) },
      nextPollAfterMs: null,
    });
    expect(await fx.state()).toMatchObject({ available: 9, reservations: 1, results: 0 });
  });
});
