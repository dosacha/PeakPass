import { initRedis, closeRedis } from '@/infra/redis/client';
import { loadConfig } from '@/infra/config';
import { initLogger } from '@/infra/logger';
import {
  setReservationHold,
  getReservationHold,
  checkRateLimit,
  setIdempotencyResult,
  getIdempotencyResult,
  tryAcquireIdempotencyLock,
  releaseIdempotencyLock,
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

      await setIdempotencyResult('checkout', idempotencyKey, orderResult, 3600);

      const cachedResult = await getIdempotencyResult('checkout', idempotencyKey);

      expect(cachedResult).toBeTruthy();
      expect(cachedResult?.orderId).toBe(orderResult.orderId);
      expect(cachedResult?.totalAmount).toBe(orderResult.totalAmount);
      expect(cachedResult?.ticketCount).toBe(orderResult.ticketCount);
    });

    it('allows only one in-flight idempotency lock holder', async () => {
      const idempotencyKey = uuid();

      const firstToken = await tryAcquireIdempotencyLock('checkout', idempotencyKey, 5);
      const secondToken = await tryAcquireIdempotencyLock('checkout', idempotencyKey, 5);

      expect(firstToken).toBeTruthy();
      expect(secondToken).toBeNull();

      await releaseIdempotencyLock('checkout', idempotencyKey, firstToken!);

      const tokenAfterRelease = await tryAcquireIdempotencyLock('checkout', idempotencyKey, 5);
      expect(tokenAfterRelease).toBeTruthy();

      await releaseIdempotencyLock('checkout', idempotencyKey, tokenAfterRelease!);
    });

    it('release with stale token does not delete an active lock (owner fencing)', async () => {
      const idempotencyKey = uuid();

      // A가 lock 획득
      const tokenA = await tryAcquireIdempotencyLock('checkout', idempotencyKey, 30);
      expect(tokenA).toBeTruthy();

      // 가짜 token으로 release 시도 → no-op이어야 함
      await releaseIdempotencyLock('checkout', idempotencyKey, 'stale-token-from-elsewhere');

      // A의 lock은 여전히 살아있어야 함 → 다른 acquire는 null
      const tokenB = await tryAcquireIdempotencyLock('checkout', idempotencyKey, 30);
      expect(tokenB).toBeNull();

      // 정상 token으로 release
      await releaseIdempotencyLock('checkout', idempotencyKey, tokenA!);

      // 이제 acquire 가능
      const tokenC = await tryAcquireIdempotencyLock('checkout', idempotencyKey, 30);
      expect(tokenC).toBeTruthy();

      await releaseIdempotencyLock('checkout', idempotencyKey, tokenC!);
    });
  });

  describe('멱등성 command scope 격리 (R02)', () => {
    it('isolates in-flight locks by command scope for the same raw key', async () => {
      const rawKey = uuid();

      // checkout scope에서 lock 획득
      const checkoutToken = await tryAcquireIdempotencyLock('checkout', rawKey, 30);
      expect(checkoutToken).toBeTruthy();

      // 같은 raw key라도 payment-settlement scope는 독립적으로 획득 가능해야 한다
      const settlementToken = await tryAcquireIdempotencyLock('payment-settlement', rawKey, 30);
      expect(settlementToken).toBeTruthy();

      // 같은 scope의 두 번째 획득은 실패
      expect(await tryAcquireIdempotencyLock('checkout', rawKey, 30)).toBeNull();
      expect(await tryAcquireIdempotencyLock('payment-settlement', rawKey, 30)).toBeNull();

      // 다른 lock의 owner token으로 release해도 대상 lock은 살아있어야 한다
      await releaseIdempotencyLock('checkout', rawKey, settlementToken!);
      expect(await tryAcquireIdempotencyLock('checkout', rawKey, 30)).toBeNull();

      // 정상 token으로 release하면 각 scope가 다시 획득 가능
      await releaseIdempotencyLock('checkout', rawKey, checkoutToken!);
      await releaseIdempotencyLock('payment-settlement', rawKey, settlementToken!);

      const reacquiredCheckout = await tryAcquireIdempotencyLock('checkout', rawKey, 30);
      const reacquiredSettlement = await tryAcquireIdempotencyLock('payment-settlement', rawKey, 30);
      expect(reacquiredCheckout).toBeTruthy();
      expect(reacquiredSettlement).toBeTruthy();

      await releaseIdempotencyLock('checkout', rawKey, reacquiredCheckout!);
      await releaseIdempotencyLock('payment-settlement', rawKey, reacquiredSettlement!);
    });

    it('stores result caches independently per command scope for the same raw key', async () => {
      const rawKey = uuid();

      await setIdempotencyResult('checkout', rawKey, { kind: 'checkout-result' }, 60);
      await setIdempotencyResult('payment-settlement', rawKey, { kind: 'settlement-result' }, 60);

      const checkoutCached = await getIdempotencyResult('checkout', rawKey);
      const settlementCached = await getIdempotencyResult('payment-settlement', rawKey);

      expect(checkoutCached?.kind).toBe('checkout-result');
      expect(settlementCached?.kind).toBe('settlement-result');

      // key 형식 계약: scope가 포함된 key만 존재해야 한다
      expect(await redis.get(`peakpass:idempotency:checkout:${rawKey}`)).not.toBeNull();
      expect(await redis.get(`peakpass:idempotency:payment-settlement:${rawKey}`)).not.toBeNull();
      expect(await redis.get(`peakpass:idempotency:${rawKey}`)).toBeNull();
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