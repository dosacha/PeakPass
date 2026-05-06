import { getPostgresPool } from '@/infra/postgres/client';
import { getLogger } from '@/infra/logger';
import { ReservationService } from '@/core/services/reservation.service';

const logger = getLogger();

// 만료된 reservation을 5분 주기로 정리한다.
// 단일 iteration에서 처리하는 최대 개수를 제한해 sweeper가 큰 배치에 막히지 않도록 한다.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_PER_SWEEP = 200;

/**
 * setInterval 기반의 background sweeper를 시작한다.
 *
 * 만료된 active reservation을 expired로 전환하고 좌석을 events로 회수한다.
 * 동일 Node 프로세스 내부에서 동작하므로 복잡한 큐 인프라 없이 운영할 수 있고,
 * 별도 process로 분리할 필요가 생기면 BullMQ 등으로 옮긴다.
 *
 * 반환된 timer는 stopReservationSweeper에 전달해 graceful shutdown 시 정지한다.
 */
export function startReservationSweeper(): NodeJS.Timeout {
  logger.info({ intervalMs: SWEEP_INTERVAL_MS, maxPerSweep: MAX_PER_SWEEP }, 'Reservation sweeper started');

  const handle = setInterval(async () => {
    try {
      const expired = await sweepExpiredReservations(MAX_PER_SWEEP);
      if (expired > 0) {
        logger.info({ expired }, 'Reservation sweeper iteration complete');
      }
    } catch (err) {
      // sweeper iteration 실패는 다음 주기에 재시도되므로 process는 죽이지 않는다.
      logger.error({ err }, 'Reservation sweeper iteration failed');
    }
  }, SWEEP_INTERVAL_MS);

  // sweeper handle이 process를 살려두지 않도록 unref.
  // 이게 없으면 SIGTERM 후에도 sweeper가 다음 tick까지 process를 잡고 있어서
  // 종료가 SWEEP_INTERVAL_MS만큼 지연된다.
  handle.unref();

  return handle;
}

export function stopReservationSweeper(handle: NodeJS.Timeout): void {
  clearInterval(handle);
  logger.info('Reservation sweeper stopped');
}

/**
 * 만료된 reservation을 정리하고 회수한 좌석 수를 반환한다.
 *
 * 한 iteration에서 처리하는 reservation 개수를 maxPerSweep로 상한 두어
 * 한 사이클이 너무 길어지지 않도록 제어한다. 모든 만료를 한 번에 처리할 필요는 없고
 * 다음 주기에 이어서 처리하면 된다.
 *
 * 각 reservation은 ReservationService.expireReservation을 통해 정리되며,
 * 이 함수는 자체 트랜잭션으로 좌석 원복 + status 'expired' 전환을 한 묶음에 처리한다.
 */
export async function sweepExpiredReservations(maxPerSweep = MAX_PER_SWEEP): Promise<number> {
  const pool = getPostgresPool();
  const client = await pool.connect();
  const reservationService = new ReservationService();

  try {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM reservations
       WHERE status = 'active' AND expires_at <= NOW()
       ORDER BY expires_at ASC
       LIMIT $1`,
      [maxPerSweep],
    );

    if (result.rows.length === 0) {
      return 0;
    }

    let expiredCount = 0;
    for (const row of result.rows) {
      try {
        await reservationService.expireReservation(row.id);
        expiredCount += 1;
      } catch (err) {
        // 한 reservation 실패가 다른 expire를 막지 않게 개별 try/catch.
        logger.warn({ err, reservationId: row.id }, 'Failed to expire reservation in sweeper');
      }
    }

    return expiredCount;
  } finally {
    client.release();
  }
}