/**
 * R01 — Route-level Idempotency and Settlement Contract Characterization
 *
 * 이 스위트는 runtime 코드를 수정하지 않고, 실제 Fastify app(createApp)이
 * global middleware(webhook signature → jwt auth → rate limit → idempotency)를
 * 포함한 상태에서 어떤 계약으로 동작하는지 *현재 그대로* 고정한다.
 *
 * 검증 계층 표기:
 *   - "route-level"           : HTTP inject 경유, middleware 포함
 *   - "Redis unavailable"     : Redis client를 의도적으로 끊은 뒤의 DB fallback
 *   - "provider transaction"  : Redis 캐시가 아닌 order FOR UPDATE +
 *                               provider_transaction_id partial UNIQUE 검증
 *
 * 실행 전제:
 *   - 반드시 격리된 테스트 전용 PostgreSQL/Redis를 가리키는 env로 실행할 것.
 *     (beforeEach가 모든 테이블을 DELETE한다 — 개발 DB를 향하면 데이터가 사라진다)
 *   - CI에서는 service container(localhost:5432/6379)가 그 역할을 한다.
 */

// ── 테스트 전용 env 기본값 ────────────────────────────────────────────────
// 아래 값들은 반드시 '@/..' 모듈을 하나라도 로드하기 *전에* 설정돼야 한다.
// (config는 첫 접근 시 process.env를 읽고 캐시하며, redis/commands 등은
//  모듈 평가 시점에 logger→config를 연쇄 로드한다)
// 그래서 이 파일의 runtime import는 전부 beforeAll 안의 lazy import다.
// 셸/CI가 이미 설정한 값은 그대로 존중한다.
if (!process.env.WEBHOOK_SIGNING_SECRET) {
  process.env.WEBHOOK_SIGNING_SECRET = 'route-contract-test-signing-secret';
}
// T03(Redis unavailable)에서 rate limiter가 503으로 검증을 가리지 않도록 open.
if (!process.env.RATE_LIMIT_FAIL_MODE) {
  process.env.RATE_LIMIT_FAIL_MODE = 'open';
}
// rate limit이 T04의 5건 동시 webhook 등 핵심 검증을 가리지 않도록 크게 설정.
if (!process.env.RATE_LIMIT_MAX_REQUESTS) {
  process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
}
if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = 'warn';
}

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

type Fixture = {
  eventId: string;
  tierId: string;
  userId: string;
  token: string;
};

type CheckoutResponseBody = {
  order: { id: string; status: string; quantity: number };
  tickets: Array<{ id: string }>;
};

type WebhookResponseBody = CheckoutResponseBody & {
  paymentStatus: string;
  duplicate: boolean;
};

describe('route-level contract: checkout idempotency and settlement webhook', () => {
  let app: FastifyInstance;
  let pool: Pool;
  let redisModule: typeof import('@/infra/redis/client');
  let postgresModule: typeof import('@/infra/postgres/client');
  let jwtSecret: string;
  let webhookSecret: string;

  beforeAll(async () => {
    const { loadConfig } = await import('@/infra/config');
    const config = loadConfig();
    jwtSecret = config.JWT_SECRET;
    if (!config.WEBHOOK_SIGNING_SECRET) {
      throw new Error('route-contract tests require WEBHOOK_SIGNING_SECRET to be configured');
    }
    webhookSecret = config.WEBHOOK_SIGNING_SECRET;

    const { initLogger } = await import('@/infra/logger');
    initLogger();

    postgresModule = await import('@/infra/postgres/client');
    pool = await postgresModule.initPostgresPool();

    redisModule = await import('@/infra/redis/client');
    await redisModule.initRedis();

    const { createApp } = await import('@/api/app');
    app = await createApp();
    await app.ready();
  }, 60000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (postgresModule) {
      await postgresModule.closePostgresPool();
    }
    if (redisModule) {
      await ensureRedisOpen().catch(() => undefined);
      await redisModule.closeRedis();
    }
  }, 30000);

  beforeEach(async () => {
    await clearTestData();
    await clearRedisData();
  });

  // ── 공용 헬퍼 ──────────────────────────────────────────────────────────

  async function clearTestData() {
    // FK 순서: tickets → payment_records → orders → reservations → events/users
    await pool.query('DELETE FROM tickets');
    await pool.query('DELETE FROM payment_records');
    await pool.query('DELETE FROM orders');
    await pool.query('DELETE FROM reservations');
    await pool.query('DELETE FROM events');
    await pool.query('DELETE FROM users');
  }

  async function ensureRedisOpen() {
    const redis = redisModule.getRedis();
    if (!redis.isOpen) {
      await redis.connect();
    }
    return redis;
  }

  async function clearRedisData() {
    const redis = await ensureRedisOpen();
    const keys = await redis.keys('peakpass:*');
    if (keys.length > 0) {
      await Promise.all(keys.map((key) => redis.del(key)));
    }
  }

  async function setupEventAndUser(seats: number): Promise<Fixture> {
    const eventId = uuid();
    const tierId = uuid();
    const userId = uuid();
    const startsAt = new Date(Date.now() + 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);

    await pool.query(
      `
      INSERT INTO events (id, name, starts_at, ends_at, total_seats, available_seats, pricing, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'published')
      `,
      [
        eventId,
        'Route contract test event',
        startsAt,
        endsAt,
        seats,
        seats,
        JSON.stringify([{ id: tierId, name: 'General', price: 50, quantity: seats }]),
      ],
    );

    await pool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
      userId,
      `route-${userId.slice(0, 8)}@test.local`,
      `Route user ${userId.slice(0, 4)}`,
    ]);

    // ENFORCE_AUTH_USER_MATCH=true(운영 기본값) 경로를 그대로 태우기 위해
    // 실제 JWT를 발급한다 (subject = body.userId).
    const token = jwt.sign({ email: `route-${userId.slice(0, 8)}@test.local` }, jwtSecret, {
      subject: userId,
      expiresIn: 600,
    });

    return { eventId, tierId, userId, token };
  }

  function postCheckout(fixture: Fixture, idempotencyKey: string, quantity = 1) {
    return app.inject({
      method: 'POST',
      url: '/checkouts',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${fixture.token}`,
        'idempotency-key': idempotencyKey,
      },
      payload: JSON.stringify({
        eventId: fixture.eventId,
        userId: fixture.userId,
        quantity,
        tierId: fixture.tierId,
      }),
    });
  }

  async function createPendingOrderViaRoute(fixture: Fixture, quantity = 1): Promise<string> {
    const response = await postCheckout(fixture, uuid(), quantity);
    expect(response.statusCode).toBe(201);
    return (response.json() as CheckoutResponseBody).order.id;
  }

  function signWebhook(rawBody: string, timestamp: string): string {
    // 미들웨어 구현을 import해서 서명하면 자기참조 검증이 되므로,
    // Stripe-style 계약(`${timestamp}.${rawBody}` HMAC-SHA256)을 독립 구현으로 재현한다.
    return crypto
      .createHmac('sha256', webhookSecret)
      .update(`${timestamp}.`)
      .update(Buffer.from(rawBody, 'utf8'))
      .digest('hex');
  }

  type WebhookOverrides = {
    timestamp?: string;
    signature?: string;
    omitSignature?: boolean;
    omitTimestamp?: boolean;
  };

  function postSettlementWebhook(
    body: { orderId: string; providerTransactionId: string; status: 'settled' | 'failed' },
    idempotencyKey: string,
    overrides: WebhookOverrides = {},
  ) {
    const rawBody = JSON.stringify(body);
    const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
    const signature = overrides.signature ?? signWebhook(rawBody, timestamp);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    };
    if (!overrides.omitTimestamp) {
      headers['x-webhook-timestamp'] = timestamp;
    }
    if (!overrides.omitSignature) {
      headers['x-webhook-signature'] = signature;
    }

    return app.inject({
      method: 'POST',
      url: '/webhooks/payments/settlement',
      headers,
      payload: rawBody,
    });
  }

  async function countOrdersByIdempotencyKey(key: string): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM orders WHERE idempotency_key = $1`,
      [key],
    );
    return result.rows[0].count;
  }

  async function getAvailableSeats(eventId: string): Promise<number> {
    const result = await pool.query(`SELECT available_seats FROM events WHERE id = $1`, [eventId]);
    return result.rows[0].available_seats;
  }

  async function getOrderStatus(orderId: string): Promise<string | null> {
    const result = await pool.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
    return result.rows[0]?.status ?? null;
  }

  async function countPendingPaymentRecords(orderId: string): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM payment_records WHERE order_id = $1 AND status = 'pending'`,
      [orderId],
    );
    return result.rows[0].count;
  }

  async function countProviderLinkedPaymentRecords(orderId: string): Promise<number> {
    const result = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM payment_records
      WHERE order_id = $1 AND provider_transaction_id IS NOT NULL
      `,
      [orderId],
    );
    return result.rows[0].count;
  }

  async function countTickets(orderId: string): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM tickets WHERE order_id = $1`,
      [orderId],
    );
    return result.rows[0].count;
  }

  // ── T01 ────────────────────────────────────────────────────────────────

  it(
    'T01 route-level: sequential checkout replay with the same Idempotency-Key converges to one order',
    async () => {
      const fixture = await setupEventAndUser(5);
      const idempotencyKey = uuid();

      const first = await postCheckout(fixture, idempotencyKey);
      expect(first.statusCode).toBe(201);
      const firstBody = first.json() as CheckoutResponseBody;
      expect(firstBody.order.status).toBe('pending');
      expect(firstBody.tickets).toHaveLength(0);

      // 순차 재시도: 현재 구현은 Redis result cache 경로로 동일 201 body를 재생한다.
      const second = await postCheckout(fixture, idempotencyKey);
      expect(second.statusCode).toBe(201);
      const secondBody = second.json() as CheckoutResponseBody;
      expect(secondBody.order.id).toBe(firstBody.order.id);

      expect(await countOrdersByIdempotencyKey(idempotencyKey)).toBe(1);
      expect(await getAvailableSeats(fixture.eventId)).toBe(4); // quantity=1, 정확히 1회 차감
      expect(await countPendingPaymentRecords(firstBody.order.id)).toBe(1);
    },
    20000,
  );

  // ── T02 ────────────────────────────────────────────────────────────────

  it(
    'T02 route-level: concurrent same-key checkouts return only 201 or 409 IDEMPOTENCY_IN_PROGRESS and converge',
    async () => {
      const fixture = await setupEventAndUser(5);
      const idempotencyKey = uuid();

      const responses = await Promise.all([
        postCheckout(fixture, idempotencyKey),
        postCheckout(fixture, idempotencyKey),
        postCheckout(fixture, idempotencyKey),
      ]);

      const statuses = responses.map((response) => response.statusCode);

      // 응답 분포(201/201/201, 201/201/409, 201/409/409)는 스케줄링에 따라
      // 달라질 수 있으므로 특정 분포를 고정하지 않는다.
      for (const status of statuses) {
        expect([201, 409]).toContain(status);
      }
      expect(statuses.some((status) => status >= 500)).toBe(false);
      expect(statuses.filter((status) => status === 201).length).toBeGreaterThanOrEqual(1);

      const successOrderIds = new Set(
        responses
          .filter((response) => response.statusCode === 201)
          .map((response) => (response.json() as CheckoutResponseBody).order.id),
      );
      expect(successOrderIds.size).toBe(1);
      const [orderId] = [...successOrderIds];

      for (const response of responses) {
        if (response.statusCode === 409) {
          const body = response.json() as { error: { code: string } };
          expect(body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
        }
      }

      // 모든 요청 완료 후 같은 key 재요청은 201로 최초 order에 수렴해야 한다.
      const followUp = await postCheckout(fixture, idempotencyKey);
      expect(followUp.statusCode).toBe(201);
      expect((followUp.json() as CheckoutResponseBody).order.id).toBe(orderId);

      expect(await countOrdersByIdempotencyKey(idempotencyKey)).toBe(1);
      expect(await getAvailableSeats(fixture.eventId)).toBe(4);
      expect(await countPendingPaymentRecords(orderId)).toBe(1);
    },
    20000,
  );

  // ── T03 ────────────────────────────────────────────────────────────────

  it(
    'T03 route-level, Redis unavailable: concurrent same-key checkouts fall back to PostgreSQL and converge to one order',
    async () => {
      const fixture = await setupEventAndUser(5);
      const idempotencyKey = uuid();

      const redis = await ensureRedisOpen();
      // Redis 장애 시뮬레이션: client를 끊으면 이후 모든 명령이 즉시 reject되고,
      // idempotency lock/result cache/rate limit이 전부 degrade 경로로 빠진다.
      // (RATE_LIMIT_FAIL_MODE=open이므로 rate limiter가 503으로 가리지 않는다)
      await redis.disconnect();

      let responses;
      try {
        responses = await Promise.all([
          postCheckout(fixture, idempotencyKey),
          postCheckout(fixture, idempotencyKey),
          postCheckout(fixture, idempotencyKey),
        ]);
      } finally {
        await redis.connect();
      }

      const statuses = responses.map((response) => response.statusCode);
      expect(statuses.some((status) => status >= 500)).toBe(false);

      // Redis lock이 없으므로 세 요청 모두 DB 경로로 진행하고,
      // pg_advisory_xact_lock + orders.idempotency_key UNIQUE(+40001 retry)로
      // 같은 logical order에 수렴한다. 현재 구현 계약은 3건 모두 201이다.
      expect(statuses).toEqual([201, 201, 201]);

      const orderIds = new Set(
        responses.map((response) => (response.json() as CheckoutResponseBody).order.id),
      );
      expect(orderIds.size).toBe(1);
      const [orderId] = [...orderIds];

      expect(await countOrdersByIdempotencyKey(idempotencyKey)).toBe(1);
      expect(await getAvailableSeats(fixture.eventId)).toBe(4);
      expect(await countPendingPaymentRecords(orderId)).toBe(1);

      // Redis 복구 후 같은 key 재요청도 동일 order를 반환해야 한다.
      const afterRecovery = await postCheckout(fixture, idempotencyKey);
      expect(afterRecovery.statusCode).toBe(201);
      expect((afterRecovery.json() as CheckoutResponseBody).order.id).toBe(orderId);
    },
    30000,
  );

  // ── T04 ────────────────────────────────────────────────────────────────

  it(
    'T04 route-level, provider transaction: 5 concurrent settlements with distinct Idempotency-Keys issue exactly one ticket',
    async () => {
      const fixture = await setupEventAndUser(5);
      const orderId = await createPendingOrderViaRoute(fixture, 1);
      const providerTransactionId = `route-txn-${uuid()}`;
      const body = { orderId, providerTransactionId, status: 'settled' as const };

      // Idempotency-Key를 전부 다르게 두어 Redis result cache가 아니라
      // order FOR UPDATE + provider_transaction_id partial UNIQUE 경로를 검증한다.
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => postSettlementWebhook(body, uuid())),
      );

      const statuses = responses.map((response) => response.statusCode);
      expect(statuses).toEqual([200, 200, 200, 200, 200]);

      const bodies = responses.map((response) => response.json() as WebhookResponseBody);
      for (const parsed of bodies) {
        expect(parsed.order.id).toBe(orderId);
        expect(parsed.paymentStatus).toBe('settled');
        expect(parsed.tickets).toHaveLength(1);
      }

      const duplicateFlags = bodies.map((parsed) => parsed.duplicate);
      expect(duplicateFlags.filter((flag) => flag === false)).toHaveLength(1);
      expect(duplicateFlags.filter((flag) => flag === true)).toHaveLength(4);

      const ticketIds = new Set(bodies.map((parsed) => parsed.tickets[0].id));
      expect(ticketIds.size).toBe(1);

      expect(await getOrderStatus(orderId)).toBe('paid');
      expect(await countTickets(orderId)).toBe(1);
      // provider-linked settlement record는 정확히 1건.
      expect(await countProviderLinkedPaymentRecords(orderId)).toBe(1);
      // checkout이 만든 pending record는 별도로 존재한다
      // (전체 payment_records를 1로 단정하지 않는 이유).
      expect(await countPendingPaymentRecords(orderId)).toBe(1);
    },
    30000,
  );

  // ── T05 ────────────────────────────────────────────────────────────────

  it(
    'T05 route-level: settlement webhook HMAC/timestamp rejection leaves order, payments, and tickets untouched',
    async () => {
      const fixture = await setupEventAndUser(5);
      const orderId = await createPendingOrderViaRoute(fixture, 1);
      const seatsAfterCheckout = await getAvailableSeats(fixture.eventId);
      const body = { orderId, providerTransactionId: `route-txn-${uuid()}`, status: 'settled' as const };

      // signature 없음
      const missingSignature = await postSettlementWebhook(body, uuid(), { omitSignature: true });
      expect(missingSignature.statusCode).toBe(401);
      expect((missingSignature.json() as { error: { code: string } }).error.code).toBe(
        'MISSING_SIGNATURE',
      );

      // timestamp 없음
      const missingTimestamp = await postSettlementWebhook(body, uuid(), { omitTimestamp: true });
      expect(missingTimestamp.statusCode).toBe(401);
      expect((missingTimestamp.json() as { error: { code: string } }).error.code).toBe(
        'MISSING_TIMESTAMP',
      );

      // 잘못된 signature (길이는 같고 내용만 다른 hex)
      const validTimestamp = String(Math.floor(Date.now() / 1000));
      const validSignature = signWebhook(JSON.stringify(body), validTimestamp);
      const tamperedSignature =
        (validSignature[0] === 'a' ? 'b' : 'a') + validSignature.slice(1);
      const wrongSignature = await postSettlementWebhook(body, uuid(), {
        timestamp: validTimestamp,
        signature: tamperedSignature,
      });
      expect(wrongSignature.statusCode).toBe(401);
      expect((wrongSignature.json() as { error: { code: string } }).error.code).toBe(
        'INVALID_SIGNATURE',
      );

      // 허용 범위(WEBHOOK_REPLAY_TOLERANCE_SECONDS, 기본 300초)를 벗어난 timestamp.
      // 서명 자체는 그 timestamp 기준으로 유효하게 만들어 window 검증만 실패시킨다.
      const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
      const staleResponse = await postSettlementWebhook(body, uuid(), {
        timestamp: staleTimestamp,
      });
      expect(staleResponse.statusCode).toBe(401);
      expect((staleResponse.json() as { error: { code: string } }).error.code).toBe(
        'TIMESTAMP_OUT_OF_WINDOW',
      );

      // 위 거부 요청들은 어떤 상태도 바꾸지 않아야 한다.
      expect(await getOrderStatus(orderId)).toBe('pending');
      expect(await countTickets(orderId)).toBe(0);
      expect(await countProviderLinkedPaymentRecords(orderId)).toBe(0);
      expect(await countPendingPaymentRecords(orderId)).toBe(1); // checkout pending만 존재
      expect(await getAvailableSeats(fixture.eventId)).toBe(seatsAfterCheckout);
    },
    20000,
  );

  // ── T06 ────────────────────────────────────────────────────────────────

  it(
    'T06 route-level: sequential settlement replay with the same Idempotency-Key returns the same ticket without reprocessing',
    async () => {
      const fixture = await setupEventAndUser(5);
      const orderId = await createPendingOrderViaRoute(fixture, 1);
      const providerTransactionId = `route-txn-${uuid()}`;
      const body = { orderId, providerTransactionId, status: 'settled' as const };
      const idempotencyKey = uuid();

      const first = await postSettlementWebhook(body, idempotencyKey);
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as WebhookResponseBody;
      expect(firstBody.duplicate).toBe(false);
      expect(firstBody.tickets).toHaveLength(1);

      const second = await postSettlementWebhook(body, idempotencyKey);
      expect(second.statusCode).toBe(200);
      const secondBody = second.json() as WebhookResponseBody;

      // 현재 계약: 두 번째 응답은 Redis result cache가 재생한 *첫 응답 그대로*다.
      // 따라서 duplicate 플래그도 첫 응답 값(false)을 유지한다 — 재처리가 아니라
      // 캐시 재생이라는 증거이므로 그대로 고정한다.
      expect(secondBody.duplicate).toBe(false);
      expect(secondBody.order.id).toBe(orderId);
      expect(secondBody.tickets).toHaveLength(1);
      expect(secondBody.tickets[0].id).toBe(firstBody.tickets[0].id);

      // 티켓과 provider-linked settlement record는 증가하지 않아야 한다.
      expect(await countTickets(orderId)).toBe(1);
      expect(await countProviderLinkedPaymentRecords(orderId)).toBe(1);
      expect(await getOrderStatus(orderId)).toBe('paid');
    },
    20000,
  );
});
