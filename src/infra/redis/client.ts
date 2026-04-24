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

export const redisKeys = {
  eventById: (eventId: string) => `peakpass:event:${eventId}`,
  eventsList: () => 'peakpass:events:list',
  eventAvailability: (eventId: string) => `peakpass:event:${eventId}:availability`,
  reservation: (reservationId: string) => `peakpass:reservation:${reservationId}`,
  userReservations: (userId: string) => `peakpass:user:${userId}:reservations`,
  rateLimitCheckout: (userId: string) => `peakpass:ratelimit:checkout:${userId}`,
  rateLimitReservation: (userId: string) => `peakpass:ratelimit:reservation:${userId}`,
  idempotencyKey: (key: string) => `peakpass:idempotency:${key}`,
  idempotencyLock: (key: string) => `peakpass:idempotency:lock:${key}`,
  inventoryCount: (eventId: string) => `peakpass:inventory:${eventId}:count`,
};
