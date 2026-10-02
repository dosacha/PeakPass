import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import type { Pool } from 'pg';
import { serializableTransactionWithRetry } from '@/infra/postgres/client';
import { readAdmissionPolicy } from '@/infra/postgres/admission-policy';
import { admissionKeys, runAdmission, RedisAdmissionEntry } from '@/infra/redis/admission';
import type { AdmissionService } from '@/core/services/admission.service';
import type { initRedis } from '@/infra/redis/client';

type Redis = Awaited<ReturnType<typeof initRedis>>;
export const TIER = 'general';
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The contract's explicit transition (exclusive gate, real UPDATE). P5 adds no activation route.
export const setProtected = (eventId: string, value: boolean) =>
  serializableTransactionWithRetry(async (c) => {
    await readAdmissionPolicy(c, eventId, 'exclusive');
    await c.query('UPDATE admission_events SET protected=$2 WHERE event_id=$1', [eventId, value]);
  });

export async function purchaseFixture(pool: Pool, secret: string, seats = 20, userCount = 3) {
  const eventId = randomUUID(),
    users = Array.from({ length: userCount }, () => randomUUID());
  for (const id of users)
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [id, `${id}@p5.test`]);
  await pool.query(
    `INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats,pricing,status)
    VALUES($1,'p5 purchase',NOW()+interval '1 hour',NOW()+interval '2 hours',$2,$2,$3,'published')`,
    [eventId, seats, JSON.stringify([{ id: TIER, name: 'General', price: 50, quantity: seats }])],
  );
  const token = (userId: string) => `Bearer ${jwt.sign({ sub: userId }, secret, { expiresIn: '1h' })}`;
  async function state() {
    return (
      await pool.query(
        `SELECT e.available_seats AS available,e.total_seats AS total,
        (SELECT COALESCE(SUM(quantity),0)::int FROM reservations
          WHERE event_id=e.id AND status='active') AS held,
        (SELECT COALESCE(SUM(quantity),0)::int FROM orders
          WHERE event_id=e.id AND status IN ('pending','paid','delivered')) AS ordered,
        (SELECT COUNT(*)::int FROM reservations WHERE event_id=e.id) AS reservations,
        (SELECT COUNT(*)::int FROM orders WHERE event_id=e.id) AS orders,
        (SELECT COUNT(*)::int FROM admission_results WHERE event_id=e.id) AS results
        FROM events e WHERE e.id=$1`,
        [eventId],
      )
    ).rows[0] as Record<
      'available' | 'total' | 'held' | 'ordered' | 'reservations' | 'orders' | 'results',
      number
    >;
  }
  // Final SQL of contract §8: a converted reservation is counted once, through its order.
  async function verify() {
    const s = await state();
    expect(s.available + s.held + s.ordered).toBe(s.total);
    const mismatched = await pool.query(
      `SELECT a.admission_id FROM admission_results a
      LEFT JOIN reservations r ON r.id=a.reservation_id LEFT JOIN orders o ON o.id=a.order_id
      WHERE a.event_id=$1 AND a.outcome='consumed' AND NOT COALESCE(
        (a.operation='reservation' AND r.user_id=a.user_id AND r.event_id=a.event_id
          AND r.tier_id=a.fingerprint::jsonb->>4 AND r.quantity=(a.fingerprint::jsonb->>5)::int)
        OR (a.operation='direct-checkout' AND o.user_id=a.user_id AND o.event_id=a.event_id
          AND o.reservation_id IS NULL AND o.tier_id=a.fingerprint::jsonb->>4
          AND o.quantity=(a.fingerprint::jsonb->>5)::int
          AND o.idempotency_key::text=a.fingerprint::jsonb->>6), false)`,
      [eventId],
    );
    expect(mismatched.rows).toEqual([]);
  }
  const results = async () =>
    (
      await pool.query(
        `SELECT admission_id AS "admissionId",user_id AS "userId",epoch::text,operation,fingerprint,
        outcome,reservation_id AS "reservationId",order_id AS "orderId",error_code AS "errorCode",
        http_status AS "httpStatus",error_message AS "errorMessage"
        FROM admission_results WHERE event_id=$1 ORDER BY created_at,admission_id`,
        [eventId],
      )
    ).rows;
  async function cleanup(redis: Redis) {
    const holds = await pool.query('SELECT id FROM reservations WHERE event_id=$1', [eventId]);
    await pool.query('DELETE FROM admission_results WHERE event_id=$1', [eventId]);
    await pool.query('DELETE FROM tickets WHERE event_id=$1', [eventId]);
    await pool.query(
      'DELETE FROM payment_records WHERE order_id IN (SELECT id FROM orders WHERE event_id=$1)',
      [eventId],
    );
    await pool.query('DELETE FROM orders WHERE event_id=$1', [eventId]);
    await pool.query('DELETE FROM reservations WHERE event_id=$1', [eventId]);
    await pool.query('DELETE FROM events WHERE id=$1', [eventId]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    const keys = [
      ...(await redis.keys(`peakpass:admission:${eventId}:*`)),
      ...holds.rows.map((r) => `peakpass:reservation:${r.id}`),
      ...(await redis.keys('peakpass:ratelimit:*')).filter((k) => users.some((u) => k.endsWith(u))),
    ];
    if (keys.length) await redis.del(keys);
  }
  return { eventId, users, token, state, verify, results, cleanup };
}
export type PurchaseFixture = Awaited<ReturnType<typeof purchaseFixture>>;

/** Registers the user and ticks the real promotion Lua until this entry is admitted. */
export async function admit(service: AdmissionService, eventId: string, userId: string) {
  const admissionEpoch = (await service.control(eventId))!.epoch;
  const joined = await service.join(eventId, userId, admissionEpoch, randomUUID());
  const admissionId = joined.body.admission!.admissionId;
  for (let attempt = 0; attempt < 40; attempt++) {
    await service.promote(eventId);
    if ((await inspect(eventId, admissionEpoch, admissionId)).state === 'admitted')
      return { admissionId, admissionEpoch };
    await sleep(250);
  }
  throw new Error('The admission was not promoted');
}

export const inspect = async (eventId: string, epoch: string, admissionId: string) =>
  (await runAdmission(eventId, epoch, 'inspect', { admissionId })).entry!;

// Synthetic time: written fields only. Every transition that follows is a real Lua command.
export async function age(
  redis: Redis,
  eventId: string,
  epoch: string,
  admissionId: string,
  fields: Partial<Pick<RedisAdmissionEntry, 'expiresAt' | 'deadline'>>,
) {
  const keys = admissionKeys(eventId, epoch),
    entry = { ...(await inspect(eventId, epoch, admissionId)), ...fields };
  await redis.hSet(keys[2], admissionId, JSON.stringify(entry));
  if (fields.deadline !== undefined)
    await redis.zAdd(keys[9], { score: fields.deadline, value: admissionId });
  return entry;
}

/** Admitted-idle plus unresolved-claim slots in use, without the sentinel. */
export const slots = async (redis: Redis, eventId: string, epoch: string) =>
  (await redis.zCard(admissionKeys(eventId, epoch)[8])) - 1;
