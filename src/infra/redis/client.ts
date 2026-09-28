import { createClient, RedisClientType } from 'redis';
import { getConfig } from '../config';
import { getLogger } from '../logger';

let redisClient: RedisClientType | null = null;
let connecting: Promise<RedisClientType> | null = null;
let socketAbort: AbortController | null = null;
let shuttingDown = false;

export async function initRedis(): Promise<RedisClientType> {
  if (shuttingDown) throw new Error('Redis is shutting down');
  if (connecting) return connecting;
  if (redisClient?.isOpen) {
    if (!redisClient.isReady) throw new Error('Redis unavailable');
    return redisClient;
  }

  const config = getConfig();
  const logger = getLogger();
  socketAbort?.abort();
  const abort = new AbortController();
  socketAbort = abort;
  const socket = {
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    signal: abort.signal,
    connectTimeout: 1000,
    reconnectStrategy: (retries: number) => {
      if (shuttingDown || abort.signal.aborted) return false;
      if (retries > 10) return new Error('Redis: Max reconnection attempts exceeded');
      return Math.min(retries * 50, 500);
    },
  };
  const client: RedisClientType = createClient({
    disableOfflineQueue: true,
    socket,
    password: config.REDIS_PASSWORD || undefined,
  });
  redisClient = client;
  client.on('error', (err) => {
    if (!shuttingDown) logger.error({ err }, 'Redis connection error');
  });
  client.on('connect', () => logger.info('Redis connected'));

  // Bound acquisition, including a TCP peer that accepts but never completes the Redis handshake.
  const timeout = setTimeout(() => abort.abort(), 5000);
  connecting = (async () => {
    try {
      await client.connect();
      if (shuttingDown || !client.isReady || abort.signal.aborted) {
        throw new Error('Redis unavailable');
      }
      return client;
    } catch (err) {
      abort.abort();
      if (client.isOpen) await client.disconnect();
      throw err;
    } finally {
      clearTimeout(timeout);
      connecting = null;
    }
  })();
  return connecting;
}

export function getRedis(): RedisClientType {
  if (shuttingDown) throw new Error('Redis is shutting down');
  if (!redisClient) throw new Error('Redis not initialized. Call initRedis() first.');
  return redisClient;
}

export async function getReadyRedis(): Promise<RedisClientType> {
  const client = getRedis();
  if (connecting) return connecting;
  if (!client.isOpen) return initRedis();
  if (!client.isReady) throw new Error('Redis unavailable');
  return client;
}

export async function withRedis<T>(operation: (client: RedisClientType) => Promise<T>): Promise<T> {
  const client = await getReadyRedis();
  if (shuttingDown || client !== redisClient) throw new Error('Redis unavailable');
  const abort = socketAbort;
  // Retire the stalled socket and flush its real command queue, not just the caller's wait.
  const timeout = setTimeout(() => abort?.abort(), 5000);
  try {
    return await operation(client);
  } finally {
    clearTimeout(timeout);
  }
}

export async function closeRedis(): Promise<void> {
  shuttingDown = true;
  // Abort also owns a TCP socket not yet assigned by node-redis's connect loop.
  socketAbort?.abort();
  if (redisClient?.isOpen) await redisClient.disconnect();
  await connecting?.catch(() => undefined);
  redisClient = null;
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
