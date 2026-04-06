import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getLogger } from '@/infra/logger';
import { getPostgresPool } from '@/infra/postgres/client';
import { getRedis } from '@/infra/redis/client';

const logger = getLogger();

export async function healthCheck(_request: FastifyRequest, _reply: FastifyReply) {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };
}

export async function readinessProbe(_request: FastifyRequest, reply: FastifyReply) {
  const checks: Record<string, boolean> = {
    postgres: false,
    redis: false,
  };

  try {
    const pgPool = getPostgresPool();
    const pgResult = await pgPool.query('SELECT 1');
    checks.postgres = pgResult.rows.length > 0;
    logger.debug('PostgreSQL ready');
  } catch (err) {
    logger.warn({ err }, 'PostgreSQL not ready');
  }

  try {
    const redis = getRedis();
    const pongResult = await redis.ping();
    checks.redis = pongResult === 'PONG';
    logger.debug('Redis ready');
  } catch (err) {
    logger.warn({ err }, 'Redis not ready');
  }

  const isReady = Object.values(checks).every(Boolean);
  if (!isReady) {
    return reply.status(503).send({
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      checks,
    });
  }

  return {
    status: 'ready',
    timestamp: new Date().toISOString(),
    checks,
  };
}

export async function registerHealthChecks(fastify: FastifyInstance) {
  fastify.get('/health', healthCheck);
  fastify.get('/ready', readinessProbe);

  logger.info('Health check endpoints registered');
  logger.info('   Liveness: GET /health (always 200)');
  logger.info('   Readiness: GET /ready (200 if deps ready, 503 if degraded)');
}
