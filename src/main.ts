import { loadConfig, getConfig } from '@/infra/config';
import { initLogger, getLogger } from '@/infra/logger';
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';
import { initRedis, closeRedis } from '@/infra/redis/client';
import { createApp } from '@/api/app';
import { startReservationSweeper, stopReservationSweeper } from '@/infra/cron/reservation-sweeper';

import { startOrderSweeper } from '@/infra/cron/order-sweeper';
import { startAdmissionScheduler } from '@/infra/cron/admission-scheduler';
import { admissionService, assertAdmissionLedger } from '@/core/services/admission.service';

let app: Awaited<ReturnType<typeof createApp>> | null = null;
let sweeperHandle: NodeJS.Timeout | null = null;
let orderSweeper: ReturnType<typeof startOrderSweeper> | null = null;
let admissionScheduler: ReturnType<typeof startAdmissionScheduler> | null = null;
let shuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  const redisClosed = Promise.allSettled([closeRedis()]);
  const ordersStopped = orderSweeper?.stop();
  const admissionStopped = admissionScheduler?.stop();

  const logger = getLogger() || console;
  logger.info(`${signal} 수신, 종료 절차 시작`);

  try {
    if (sweeperHandle) {
      stopReservationSweeper(sweeperHandle);
      sweeperHandle = null;
    }

    if (app) {
      await app.close();
      logger.info('HTTP 서버 종료');
    }

    await ordersStopped;
    await admissionStopped;
    await closePostgresPool();
    logger.info('PostgreSQL 연결 종료');

    const [redisResult] = await redisClosed;
    if (redisResult.status === 'rejected') throw redisResult.reason;
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
    await assertAdmissionLedger();
    if(config.ENABLE_ADMISSION) await admissionService.verifyEnvironment();

    app = await createApp();

    process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

    sweeperHandle = startReservationSweeper();
    orderSweeper = startOrderSweeper();
    if(config.ENABLE_ADMISSION) admissionScheduler = startAdmissionScheduler();

    await app.listen({ port: config.PORT, host: '0.0.0.0' });

    logger.info(`서버 실행 시작: ${config.PORT}`);
    logger.info(`헬스 체크: http://localhost:${config.PORT}/health`);
    logger.info(`준비 상태: http://localhost:${config.PORT}/ready`);
  } catch (err) {
    const logger = getLogger() || console;
    logger.error({ err }, '애플리케이션 시작 실패');

    // Fence Redis and scheduling immediately; finish the active order transaction before closing its pool.
    const redisClosed = Promise.allSettled([closeRedis()]);
    const ordersStopped = orderSweeper?.stop();
    const admissionStopped = admissionScheduler?.stop();
    if (sweeperHandle) stopReservationSweeper(sweeperHandle);
    await Promise.allSettled([ordersStopped, admissionStopped, app ? app.close() : Promise.resolve()]);
    await Promise.allSettled([closePostgresPool(), redisClosed]);
    process.exit(1);
  }
}

void main();
