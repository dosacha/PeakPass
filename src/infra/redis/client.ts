import { createClient, RedisClientType } from 'redis';
import { getConfig } from '../config';
import { getLogger } from '../logger';

let redisClient: RedisClientType | null = null;

export async function initRedis(): Promise<RedisClientType> {
  const config = getConfig();
  const logger = getLogger();

  if (redisClient) {
    return redisClient;
  }

  redisClient = createClient({
    socket: {
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      reconnectStrategy: (retries: number) => {
        if (retries > 10) {
          return new Error('Redis: Max reconnection attempts exceeded');
        }

        return Math.min(retries * 50, 500);
      },
    },
    password: config.REDIS_PASSWORD || undefined,
  });

  redisClient.on('error', (err) => logger.error({ err }, 'Redis connection error'));
  redisClient.on('connect', () => logger.info('Redis connected'));

  await redisClient.connect();
  logger.info(`Redis connected to ${config.REDIS_HOST}:${config.REDIS_PORT}`);

  return redisClient;
}

export function getRedis(): RedisClientType {
  if (!redisClient) {
    throw new Error('Redis not initialized. Call initRedis() first.');
  }

  return redisClient;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    getLogger().info('Redis connection closed');
    redisClient = null;
  }
}

/**
 * 멱등성 상태(result cache, in-flight lock)가 소속된 command.
 *
 * checkout과 payment settlement는 같은 idempotency middleware를 공유하지만
 * command 의미와 response shape가 서로 다르다. Redis result cache는 DB 접근
 * *전에* 캐시된 응답을 재생할 수 있으므로, 같은 raw Idempotency-Key가
 * command 경계를 넘어 재생되지 않도록 key namespace를 scope로 분리한다.
 *
 * DB 영속성 계층의 uniqueness는 별도로 migration 005의 record-kind partial
 * UNIQUE index(provider_transaction_id NULL 여부 기준)가 담당한다.
 */
export type IdempotencyScope = 'checkout' | 'payment-settlement';

export const redisKeys = {
  eventById: (eventId: string) => `peakpass:event:${eventId}`,
  eventsList: () => 'peakpass:events:list',
  eventAvailability: (eventId: string) => `peakpass:event:${eventId}:availability`,
  reservation: (reservationId: string) => `peakpass:reservation:${reservationId}`,
  userReservations: (userId: string) => `peakpass:user:${userId}:reservations`,
  rateLimitCheckout: (userId: string) => `peakpass:ratelimit:checkout:${userId}`,
  rateLimitReservation: (userId: string) => `peakpass:ratelimit:reservation:${userId}`,
  rateLimitWebhook: (userId: string) => `peakpass:ratelimit:webhook:${userId}`,
  rateLimitGraphql: (userId: string) => `peakpass:ratelimit:graphql:${userId}`,
  rateLimitDemoSession: (ip: string) => `peakpass:ratelimit:demo-session:${ip}`,
  rateLimitDemoSettlement: (userId: string) => `peakpass:ratelimit:demo-settlement:${userId}`,
  idempotencyKey: (scope: IdempotencyScope, key: string) =>
    `peakpass:idempotency:${scope}:${key}`,
  idempotencyLock: (scope: IdempotencyScope, key: string) =>
    `peakpass:idempotency:lock:${scope}:${key}`,
  inventoryCount: (eventId: string) => `peakpass:inventory:${eventId}:count`,
};
