import { getRedis, redisKeys } from './client';
import { getLogger } from '../logger';

const logger = getLogger();

// Redis TTL 정책 (초 단위)
export const REDIS_TTL = {
  // 예약 홀드: 5분
  RESERVATION_HOLD: 300,
  // 이벤트 캐시: 10분
  EVENT_CACHE: 600,
  // 재고 수량 캐시: 1분
  INVENTORY_COUNT: 60,
  // 멱등성 키: 24시간
  IDEMPOTENCY_KEY: 86400,
  IDEMPOTENCY_LOCK: 30,
  // 레이트 리미팅 윈도우: 1분
  RATE_LIMIT_WINDOW: 60,
} as const;

/**
 * 안전한 JSON 파싱 헬퍼
 */
function safeJsonParse<T>(data: string, fallback: T): T {
  try {
    return JSON.parse(data);
  } catch (err) {
    logger.warn({ err, data: data.slice(0, 100) }, 'Invalid JSON data in Redis, using fallback');
    return fallback;
  }
}

/**
 * TTL 포함 예약 홀드 저장
 * @param reservationId
 * @param data 저장할 JSON 객체
 * @param ttlSeconds TTL 초 단위
 */
export async function setReservationHold(
  reservationId: string,
  data: Record<string, any>,
  ttlSeconds: number = REDIS_TTL.RESERVATION_HOLD,
): Promise<void> {
  const redis = getRedis();
  const key = redisKeys.reservation(reservationId);

  try {
    await redis.setEx(key, ttlSeconds, JSON.stringify(data));
    logger.debug({ reservationId, ttlSeconds }, 'Reservation hold stored in Redis');
  } catch (err) {
    logger.warn({ err }, 'Failed to set reservation hold in Redis (non-critical)');
  }
}

/**
 * Redis에서 예약 홀드 조회
 * @param reservationId
 * @returns 홀드 데이터 또는 만료/누락 시 null
 */
export async function getReservationHold(
  reservationId: string,
): Promise<Record<string, any> | null> {
  const redis = getRedis();
  const key = redisKeys.reservation(reservationId);

  try {
    const data = await redis.get(key);
    if (!data) return null;
    return safeJsonParse(data, null);
  } catch (err) {
    logger.warn({ err }, 'Failed to get reservation hold from Redis');
    return null;
  }
}

export async function deleteReservationHold(reservationId: string): Promise<void> {
  const redis = getRedis();
  const key = redisKeys.reservation(reservationId);

  try {
    await redis.del(key);
    logger.debug({ reservationId }, 'Reservation hold removed from Redis');
  } catch (err) {
    logger.warn({ err }, 'Failed to delete reservation hold from Redis');
  }
}

/**
 * 레이트 리미팅: 슬라이딩 윈도우 카운터
 * 시간 윈도우 내 요청 수 세기, 제한 내이면 true 반환
 */
export async function checkRateLimit(
  userId: string,
  action: 'checkout' | 'reservation',
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; count: number; resetAt: number }> {
  const redis = getRedis();
  const key = action === 'checkout'
    ? redisKeys.rateLimitCheckout(userId)
    : redisKeys.rateLimitReservation(userId);

  try {
    const now = Date.now();
    const windowStart = now - windowMs;

    // 윈도우 바깥 오래된 항목 제거
    await redis.zRemRangeByScore(key, 0, windowStart);

    // 현재 항목 세기
    const count = await redis.zCard(key);

    if (count >= limit) {
      const resetAt = now + windowMs;
      logger.warn(
        { userId, action, limit, count },
        'Rate limit exceeded',
      );
      return { allowed: false, count, resetAt };
    }

    // 현재 요청 추가
    await redis.zAdd(key, { score: now, value: `${now}-${Math.random()}` });
    await redis.expire(key, Math.ceil(windowMs / 1000));

    return { allowed: true, count: count + 1, resetAt: now + windowMs };
  } catch (err) {
    logger.error({ err }, '레이트 리미트 확인 실패');
    // 오픈 실패: Redis가 다운되면 요청 허용
    return { allowed: true, count: 0, resetAt: 0 };
  }
}

/**
 * 멱등성: 작업 결과 캐시
 * @param idempotencyKey
 * @param result 캐시에 저장할 JSON 결과
 * @param ttlSeconds 캐시 TTL, 기본값 24시간
 */
export async function setIdempotencyResult(
  idempotencyKey: string,
  result: Record<string, unknown>,
  ttlSeconds: number = 24 * 60 * 60,
): Promise<void> {
  const redis = getRedis();
  const key = redisKeys.idempotencyKey(idempotencyKey);

  try {
    await redis.setEx(key, ttlSeconds, JSON.stringify(result));
    logger.debug({ idempotencyKey }, 'Idempotency result cached');
  } catch (err) {
    logger.warn({ err }, 'Failed to cache idempotency result');
  }
}

/**
 * 캐시된 멱등성 결과 조회
 * @param idempotencyKey
 */
export async function getIdempotencyResult(
  idempotencyKey: string,
): Promise<Record<string, unknown> | null> {
  const redis = getRedis();
  const key = redisKeys.idempotencyKey(idempotencyKey);

  try {
    const data = await redis.get(key);
    if (!data) return null;
    logger.debug({ idempotencyKey }, 'Idempotency hit (cached result)');
    return safeJsonParse<Record<string, unknown> | null>(data, null);
  } catch (err) {
    logger.warn({ err }, 'Failed to get idempotency result');
    return null;
  }
}

export async function tryAcquireIdempotencyLock(
  idempotencyKey: string,
  ttlSeconds: number = REDIS_TTL.IDEMPOTENCY_LOCK,
): Promise<boolean> {
  const redis = getRedis();
  const key = redisKeys.idempotencyLock(idempotencyKey);
  const result = await redis.set(key, 'processing', {
    NX: true,
    EX: ttlSeconds,
  });

  return result === 'OK';
}

export async function releaseIdempotencyLock(idempotencyKey: string): Promise<void> {
  const redis = getRedis();
  const key = redisKeys.idempotencyLock(idempotencyKey);

  try {
    await redis.del(key);
  } catch (err) {
    logger.warn({ err, idempotencyKey }, 'Failed to release idempotency lock');
  }
}

/**
 * 재고 수량: 사용 가능 좌석 수 저장
 * DB와 동기화되지만 빠른 쿼리를 위해 캐시됨
 */
export async function setInventoryCount(
  eventId: string,
  count: number,
  ttlSeconds: number = 5 * 60, // 5 minutes
): Promise<void> {
  const redis = getRedis();
  const key = redisKeys.inventoryCount(eventId);

  try {
    await redis.setEx(key, ttlSeconds, JSON.stringify({ count, updatedAt: new Date().toISOString() }));
    logger.debug({ eventId, count }, 'Inventory count cached');
  } catch (err) {
    logger.warn({ err }, 'Failed to cache inventory count');
  }
}

/**
 * 캐시된 재고 수량 조회
 */
export async function getInventoryCount(eventId: string): Promise<number | null> {
  const redis = getRedis();
  const key = redisKeys.inventoryCount(eventId);

  try {
    const data = await redis.get(key);
    if (!data) return null;
    const parsed = safeJsonParse(data, { count: null });
    return parsed.count;
  } catch (err) {
    logger.warn({ err }, 'Failed to get inventory count');
    return null;
  }
}

/**
 * 이벤트 캐시 무효화
 * 체크아웃 후 데이터 최신 유지용
 */
export async function invalidateEventCache(eventId: string): Promise<void> {
  const redis = getRedis();

  try {
    await redis.del([
      redisKeys.eventById(eventId),
      redisKeys.eventAvailability(eventId),
      redisKeys.inventoryCount(eventId),
    ]);
    logger.debug({ eventId }, 'Event cache invalidated');
  } catch (err) {
    logger.warn({ err }, 'Failed to invalidate event cache');
  }
}

/**
 * 모든 이벤트 목록 캐시 정리
 */
export async function invalidateEventsList(): Promise<void> {
  const redis = getRedis();

  try {
    await redis.del(redisKeys.eventsList());
    logger.debug('Events list cache invalidated');
  } catch (err) {
    logger.warn({ err }, 'Failed to invalidate events list');
  }
}
