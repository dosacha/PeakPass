import { randomUUID } from 'crypto';
import { getRedis, redisKeys, IdempotencyScope } from './client';
import { getLogger } from '../logger';

export type { IdempotencyScope } from './client';

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
    logger.warn({ err, payloadLength: data.length }, 'Invalid JSON data in Redis, using fallback');
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
 *
 * Redis 장애 시 동작은 failMode로 결정한다:
 *   - 'closed' (default): 거부 (allowed: false, redisAvailable: false)
 *     → 보안 우선. 운영에서는 이 모드를 권장.
 *   - 'open': 허용 (allowed: true, redisAvailable: false)
 *     → 가용성 우선. browse 같은 비핵심 경로용.
 */
export async function checkRateLimit(
  userId: string,
  action: 'checkout' | 'reservation' | 'webhook' | 'graphql' | 'demoSession' | 'demoSettlement',
  limit: number,
  windowMs: number,
  failMode: 'open' | 'closed' = 'closed',
): Promise<{ allowed: boolean; count: number; resetAt: number; redisAvailable: boolean }> {
  const redis = getRedis();
  // action 별 key prefix를 분리해 한 사용자의 여러 액션이 같은 카운터를 공유하지
  // 않도록 한다 (예: GraphQL read 60건이 checkout 5건과 같은 윈도우에 들어가면
  // 의도와 다른 거부가 발생한다).
  const keyByAction: Record<typeof action, string> = {
    checkout: redisKeys.rateLimitCheckout(userId),
    reservation: redisKeys.rateLimitReservation(userId),
    webhook: redisKeys.rateLimitWebhook(userId),
    graphql: redisKeys.rateLimitGraphql(userId),
    demoSession: redisKeys.rateLimitDemoSession(userId),
    demoSettlement: redisKeys.rateLimitDemoSettlement(userId),
  };
  const key = keyByAction[action];

  try {
    const now = Date.now();
    const windowStart = now - windowMs;

    await redis.zRemRangeByScore(key, 0, windowStart);
    const count = await redis.zCard(key);

    if (count >= limit) {
      return { allowed: false, count, resetAt: now + windowMs, redisAvailable: true };
    }

    await redis.zAdd(key, { score: now, value: `${now}-${Math.random()}` });
    await redis.expire(key, Math.ceil(windowMs / 1000));

    return { allowed: true, count: count + 1, resetAt: now + windowMs, redisAvailable: true };
  } catch (err) {
    logger.error({ err, userId, action, failMode }, '레이트 리미트 확인 실패 (Redis 장애)');
    if (failMode === 'open') {
      return { allowed: true, count: 0, resetAt: 0, redisAvailable: false };
    }
    return { allowed: false, count: 0, resetAt: 0, redisAvailable: false };
  }
}

/**
 * 멱등성: 작업 결과 캐시
 *
 * scope(command)별로 key namespace를 분리한다. checkout과 settlement가 같은
 * raw Idempotency-Key를 쓰더라도 서로의 캐시 응답이 재생되면 안 되기 때문이다.
 *
 * @param scope 결과가 소속된 command
 * @param idempotencyKey
 * @param result 캐시에 저장할 JSON 결과
 * @param ttlSeconds 캐시 TTL, 기본값 24시간
 */
export async function setIdempotencyResult(
  scope: IdempotencyScope,
  idempotencyKey: string,
  result: Record<string, unknown>,
  ttlSeconds: number = 24 * 60 * 60,
): Promise<void> {
  const redis = getRedis();
  const key = redisKeys.idempotencyKey(scope, idempotencyKey);

  try {
    await redis.setEx(key, ttlSeconds, JSON.stringify(result));
    logger.debug({ scope, idempotencyKey }, 'Idempotency result cached');
  } catch (err) {
    logger.warn({ err }, 'Failed to set idempotency result');
  }
}

/**
 * 멱등성 결과 조회 (scope가 일치하는 command의 결과만 반환)
 * @param scope 조회하는 command
 * @param idempotencyKey
 * @returns 캐시된 결과 또는 누락 시 null
 */
export async function getIdempotencyResult(
  scope: IdempotencyScope,
  idempotencyKey: string,
): Promise<Record<string, unknown> | null> {
  const redis = getRedis();
  const key = redisKeys.idempotencyKey(scope, idempotencyKey);

  try {
    const data = await redis.get(key);
    if (!data) return null;
    return safeJsonParse(data, null);
  } catch (err) {
    logger.warn({ err }, 'Failed to get idempotency result');
    return null;
  }
}

/**
 * 멱등성 lock 획득 시도. owner token을 value로 저장한다.
 *
 * 반환값:
 *   - 성공: token (이후 release 시 owner 검증용)
 *   - 실패 (다른 요청이 이미 보유): null
 *
 * token을 두는 이유:
 *   - TTL 만료 후 다른 요청이 같은 key의 lock을 잡은 상태에서
 *     원래 요청이 release를 호출하면, 단순 DEL은 다른 요청의 lock을
 *     잘못 삭제하게 된다 (lock 분실 사고).
 *   - releaseIdempotencyLock에서 Lua script로 token을 비교한 후에만
 *     DEL을 실행하므로, owner가 아닌 release 호출은 무해한 no-op이 된다.
 */
export async function tryAcquireIdempotencyLock(
  scope: IdempotencyScope,
  idempotencyKey: string,
  ttlSeconds: number = REDIS_TTL.IDEMPOTENCY_LOCK,
): Promise<string | null> {
  const redis = getRedis();
  const key = redisKeys.idempotencyLock(scope, idempotencyKey);
  const token = randomUUID();
  const result = await redis.set(key, token, {
    NX: true,
    EX: ttlSeconds,
  });

  return result === 'OK' ? token : null;
}

/**
 * 멱등성 lock 해제. token이 현재 보유자와 일치하는 경우에만 삭제한다.
 *
 * Lua script로 GET + DEL을 atomic하게 묶어 race condition을 막는다:
 *   - GET 후 외부에서 DEL 사이에 TTL 만료 + 다른 요청 SET이 발생할 수 있음
 *   - script는 단일 atomic 단계로 실행되므로 그 race 자체가 발생하지 않는다.
 */
export async function releaseIdempotencyLock(
  scope: IdempotencyScope,
  idempotencyKey: string,
  token: string,
): Promise<void> {
  const redis = getRedis();
  const key = redisKeys.idempotencyLock(scope, idempotencyKey);

  try {
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      {
        keys: [key],
        arguments: [token],
      },
    );
  } catch (err) {
    logger.warn({ err, scope, idempotencyKey }, 'Failed to release idempotency lock');
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
    await redis.setEx(key, ttlSeconds, String(count));
    logger.debug({ eventId, count, ttlSeconds }, 'Inventory count cached');
  } catch (err) {
    logger.warn({ err }, 'Failed to cache inventory count');
  }
}

/**
 * 재고 수량 조회
 * @param eventId
 * @returns 캐시된 수량 또는 누락 시 null
 */
export async function getInventoryCount(eventId: string): Promise<number | null> {
  const redis = getRedis();
  const key = redisKeys.inventoryCount(eventId);

  try {
    const data = await redis.get(key);
    if (!data) return null;
    const count = parseInt(data, 10);
    return Number.isNaN(count) ? null : count;
  } catch (err) {
    logger.warn({ err }, 'Failed to get inventory count');
    return null;
  }
}

/**
 * 이벤트 캐시 무효화
 * 재고 변경 후 호출됨
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
