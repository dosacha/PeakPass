import { initRedis, closeRedis } from '@/infra/redis/client';
import { loadConfig } from '@/infra/config';
import { initLogger } from '@/infra/logger';
import {
  setReservationHold,
  getReservationHold,
  checkRateLimit,
  setIdempotencyResult,
  getIdempotencyResult,
  setInventoryCount,
  getInventoryCount,
} from '@/infra/redis/commands';
import { v4 as uuid } from 'uuid';

describe('Redis 통합 테스트', () => {
  let redis: Awaited<ReturnType<typeof initRedis>>;

  async function clearRedisData() {
    const keys = await redis.keys('peakpass:*');

    if (keys.length === 0) {
      return;
    }

    await Promise.all(keys.map((key: string) => redis.del(key)));
  }

  async function waitUntil(
    condition: () => Promise<boolean> | boolean,
    timeoutMs = 2000,
    intervalMs = 50,
  ) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (await condition()) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error('조건 확인 실패');
  }

  beforeAll(async () => {
    loadConfig();
    initLogger();
    redis = await initRedis();
  });

  afterAll(async () => {
    await closeRedis();
  });

  beforeEach(async () => {
    await clearRedisData();
  });

  afterEach(async () => {
    await clearRedisData();
  });

  describe('TTL 예약', () => {
    it(
      '예약 홀드 TTL 만료 확인',
      async () => {
        const reservationId = uuid();
        const holdData = {
          id: reservationId,
          userId: uuid(),
          eventId: uuid(),
          quantity: 2,
          tierId: 'general',
          expiresAt: new Date().toISOString(),
          status: 'active',
        };

        await setReservationHold(reservationId, holdData, 1);

        const savedHold = await getReservationHold(reservationId);
        expect(savedHold).toBeTruthy();
        expect(savedHold?.id).toBe(reservationId);

        await waitUntil(async () => (await getReservationHold(reservationId)) === null);

        const expiredHold = await getReservationHold(reservationId);
        expect(expiredHold).toBeNull();
      },
      10000,
    );
  });

  describe('레이트 리미팅', () => {
    it('슬라이딩 윈도우로 요청 제한 확인', async () => {
      const userId = uuid();
      const limit = 3;
      const windowMs = 1000;
      const results: Array<Awaited<ReturnType<typeof checkRateLimit>>> = [];

      for (let i = 0; i < 5; i++) {
        results.push(await checkRateLimit(userId, 'checkout', limit, windowMs));
      }

      const allowedCount = results.filter((result) => result.allowed).length;
      const blockedCount = results.filter((result) => !result.allowed).length;

      expect(allowedCount).toBe(limit);
      expect(blockedCount).toBe(2);
    });

    it('체크아웃과 예약 제한 분리 확인', async () => {
      const userId = uuid();
      const limit = 2;
      const windowMs = 1000;

      for (let i = 0; i < limit; i++) {
        const result = await checkRateLimit(userId, 'checkout', limit, windowMs);
        expect(result.allowed).toBe(true);
      }

      const blockedCheckout = await checkRateLimit(userId, 'checkout', limit, windowMs);
      expect(blockedCheckout.allowed).toBe(false);

      const reservationResult = await checkRateLimit(userId, 'reservation', limit, windowMs);
      expect(reservationResult.allowed).toBe(true);
    });
  });

  describe('멱등성 키 캐싱', () => {
    it('결과 캐싱 및 조회 확인', async () => {
      const idempotencyKey = uuid();
      const orderResult = {
        orderId: uuid(),
        totalAmount: 150.5,
        ticketCount: 2,
      };

      await setIdempotencyResult(idempotencyKey, orderResult, 3600);

      const cachedResult = await getIdempotencyResult(idempotencyKey);

      expect(cachedResult).toBeTruthy();
      expect(cachedResult?.orderId).toBe(orderResult.orderId);
      expect(cachedResult?.totalAmount).toBe(orderResult.totalAmount);
      expect(cachedResult?.ticketCount).toBe(orderResult.ticketCount);
    });
  });

  describe('재고 수량 캐싱', () => {
    it('수량 캐싱 및 조회 확인', async () => {
      const eventId = uuid();
      const availableSeats = 45;

      await setInventoryCount(eventId, availableSeats, 300);

      const cachedCount = await getInventoryCount(eventId);

      expect(cachedCount).toBe(availableSeats);
    });
  });
});