import { randomUUID as uuid } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { CheckoutService } from '@/core/services/checkout.service';
import { transaction } from '@/infra/postgres/client';

export async function fixture(pool: Pool, quantity = 2) {
  const userId = uuid(), eventId = uuid();
  await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [userId, `${userId}@sweeper.test`]);
  await pool.query(`INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats,pricing,status)
    VALUES($1,'Sweeper',NOW()+INTERVAL '1 day',NOW()+INTERVAL '2 days',10000,10000,$2,'published')`,
  [eventId, JSON.stringify([{ id: 'general', name: 'General', price: 50, quantity: 10000 }])]);
  async function order(due = true) {
    const result = await transaction(c => new CheckoutService().checkout({ userId, eventId, tierId: 'general', quantity, idempotencyKey: uuid() }, c));
    if ('reservationExpired' in result) throw new Error('Unexpected expired reservation');
    if (due) await pool.query(`UPDATE orders SET payment_deadline_at=NOW()-INTERVAL '2 minutes' WHERE id=$1`, [result.order.id]);
    return result.order.id;
  }
  async function state() {
    return (await pool.query(`SELECT o.id,o.status,o.paid_at,e.available_seats,
      (SELECT COUNT(*)::int FROM tickets WHERE order_id=o.id) AS tickets,
      (SELECT COUNT(*)::int FROM payment_records WHERE order_id=o.id AND reconciliation_required) AS reconciliation
      FROM orders o JOIN events e ON e.id=o.event_id WHERE e.id=$1 ORDER BY o.payment_deadline_at,o.id`, [eventId])).rows;
  }
  async function cleanup(currentPool = pool) {
    await currentPool.query('DELETE FROM tickets WHERE event_id=$1', [eventId]);
    await currentPool.query('DELETE FROM payment_records WHERE order_id IN (SELECT id FROM orders WHERE event_id=$1)', [eventId]);
    await currentPool.query('DELETE FROM orders WHERE event_id=$1', [eventId]);
    await currentPool.query('DELETE FROM reservations WHERE event_id=$1', [eventId]);
    await currentPool.query('DELETE FROM events WHERE id=$1', [eventId]);
    await currentPool.query('DELETE FROM users WHERE id=$1', [userId]);
  }
  return { userId, eventId, order, state, cleanup };
}

export async function until(check: () => Promise<boolean>, timeoutMs = 10000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  return false;
}

export async function lockOrder(pool: Pool, id: string) {
  const client = await pool.connect();
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  await client.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [id]);
  return { client, pid };
}

export async function blocked(pool: Pool, pid: number, count = 1) {
  let rows: { pid: number; blockers: number[] }[] = [];
  const observed = await until(async () => {
    rows = (await pool.query(`SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0 AND pid<>$1`, [pid])).rows;
    const chain = new Set([pid]);
    for (let i = 0; i < rows.length; i++) for (const row of rows) {
      if (row.blockers.some(blocker => chain.has(blocker))) chain.add(row.pid);
    }
    return chain.size - 1 >= count;
  });
  expect(observed).toBe(true);
  process.stdout.write(JSON.stringify({ lockBarrier: { holder: pid, waiters: rows } }) + '\n');
}

export async function release(client: PoolClient) {
  await client.query('COMMIT'); client.release();
}
