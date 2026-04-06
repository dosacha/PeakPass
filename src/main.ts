import { loadConfig, getConfig } from '@/infra/config';
import { initLogger, getLogger } from '@/infra/logger';
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';
import { initRedis, closeRedis } from '@/infra/redis/client';
import { createApp } from '@/api/app';

let app: Awaited<ReturnType<typeof createApp>> | null = null;
let shuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  const logger = getLogger() || console;
  logger.info(`${signal} 수신, 종료 절차 시작`);

  try {
    if (app) {
      await app.close();
      logger.info('HTTP 서버 종료');
    }

    await closePostgresPool();
    logger.info('PostgreSQL 연결 종료');

    await closeRedis();
    logger.info('Redis 연결 종료');

    logger.info('종료 절차 완료');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, '종료 절차 실패');
    process.exit(1);
  }
}

async function main() {
  try {
    loadConfig();
    initLogger();

    const logger = getLogger();
    const config = getConfig();

    logger.info('PeakPass 애플리케이션 시작');
    logger.info(`환경=${config.NODE_ENV}, 로그 레벨=${config.LOG_LEVEL}`);

    await initPostgresPool();
    logger.info('PostgreSQL 연결 완료');

    await initRedis();
    logger.info('Redis 연결 완료');

    app = await createApp();

    process.once('SIGINT', () => {
      void gracefulShutdown('SIGINT');
    });

    process.once('SIGTERM', () => {
      void gracefulShutdown('SIGTERM');
    });

    await app.listen({ port: config.PORT, host: '0.0.0.0' });

    logger.info(`서버 실행 시작: ${config.PORT}`);
    logger.info(`헬스 체크: http://localhost:${config.PORT}/health`);
    logger.info(`준비 상태: http://localhost:${config.PORT}/ready`);
  } catch (err) {
    const logger = getLogger() || console;
    logger.error({ err }, '애플리케이션 시작 실패');

    await Promise.allSettled([
      app ? app.close() : Promise.resolve(),
      closePostgresPool(),
      closeRedis(),
    ]);

    process.exit(1);
  }
}

void main();