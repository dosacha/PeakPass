import { performance } from 'node:perf_hooks';
import { OrderExpirationService } from '@/core/services/order-expiration.service';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';
import { getPostgresPool, serializableTransactionWithRetry } from '@/infra/postgres/client';
import { invalidateEventCache } from '@/infra/redis/commands';

export async function sweepExpiredOrders(batchSize = getConfig().ORDER_SWEEP_BATCH_SIZE, stopped = () => false) {
  const started = performance.now();
  const stats = { scanned: 0, expired: 0, skipped: 0, failed: 0, unprocessed: 0, oldestOverdueAgeSeconds: 0, durationMs: 0 };
  // pool.query releases the scan connection before per-order transactions, including at pool max 1.
  const candidates = await getPostgresPool().query<{ id: string; overdue_age_seconds: number }>(
    `SELECT id,EXTRACT(EPOCH FROM NOW()-payment_deadline_at)::float8 AS overdue_age_seconds
     FROM orders WHERE status='pending' AND payment_deadline_at IS NOT NULL AND payment_deadline_at<=NOW()
     ORDER BY payment_deadline_at,id LIMIT $1`, [batchSize],
  );
  stats.scanned = candidates.rows.length;
  stats.oldestOverdueAgeSeconds = candidates.rows[0]?.overdue_age_seconds ?? 0;
  const service = new OrderExpirationService();
  for (const { id } of candidates.rows) {
    if (stopped()) break;
    try {
      const outcome = await serializableTransactionWithRetry(c => service.expirePendingOrderWithClient(id, c));
      if (outcome.kind === 'expired_now') {
        stats.expired++;
        // Best effort and after COMMIT; Redis availability never decides order/inventory truth.
        await invalidateEventCache(outcome.order.eventId);
      } else {
        stats.skipped++;
      }
    } catch (err) {
      stats.failed++;
      getLogger().warn({ err, orderId: id }, 'Order sweeper expiration failed');
    }
  }
  stats.unprocessed = stats.scanned - stats.expired - stats.skipped - stats.failed;
  stats.durationMs = performance.now() - started;
  getLogger().info(stats, 'Order sweeper iteration complete');
  return stats;
}

export function startOrderSweeper(options: { intervalMs?: number; batchSize?: number } = {}) {
  const intervalMs = options.intervalMs ?? getConfig().ORDER_SWEEP_INTERVAL_MS;
  const batchSize = options.batchSize ?? getConfig().ORDER_SWEEP_BATCH_SIZE;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<void>;
  async function run() {
    try {
      await sweepExpiredOrders(batchSize, () => stopped);
    } catch (err) {
      getLogger().error({ err }, 'Order sweeper iteration failed');
    } finally {
      if (!stopped) {
        timer = setTimeout(() => { inflight = run(); }, intervalMs);
        timer.unref();
      }
    }
  }
  getLogger().info({ intervalMs, batchSize }, 'Order sweeper started');
  inflight = run(); // Restart catch-up never waits for the first interval.
  return {
    stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      return inflight;
    },
  };
}
