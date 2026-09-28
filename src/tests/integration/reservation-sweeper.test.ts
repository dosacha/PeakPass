import { v4 as uuid } from 'uuid';
import type { Pool } from 'pg';

describe('reservation sweeper with a single PostgreSQL connection', () => {
  let pool: Pool;
  let postgres: typeof import('@/infra/postgres/client');
  let redis: typeof import('@/infra/redis/client');
  let holds: typeof import('@/infra/redis/commands');
  let reservations: typeof import('@/core/services/reservation.service');
  let sweeper: typeof import('@/infra/cron/reservation-sweeper');
  const originalPoolMax = process.env.DB_POOL_MAX;
  const originalPoolMin = process.env.DB_POOL_MIN;
  const fixtures: Array<{ id: string; eventId: string; userId: string }> = [];

  beforeAll(async () => {
    // Runtime imports can initialize config; configure this suite's pool before loading them.
    process.env.DB_POOL_MAX = '1';
    process.env.DB_POOL_MIN = '1';
    const { loadConfig } = await import('@/infra/config');
    const { initLogger } = await import('@/infra/logger');
    postgres = await import('@/infra/postgres/client');
    redis = await import('@/infra/redis/client');
    holds = await import('@/infra/redis/commands');
    reservations = await import('@/core/services/reservation.service');
    sweeper = await import('@/infra/cron/reservation-sweeper');
    const config = loadConfig();
    expect(config.DB_POOL_MAX).toBe(1);
    expect(config.DB_POOL_MIN).toBe(1);
    initLogger();
    pool = await postgres.initPostgresPool();
    await redis.initRedis();
  });

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await holds.deleteReservationHold(fixture.id);
      await pool.query('DELETE FROM reservations WHERE id = $1', [fixture.id]);
      await pool.query('DELETE FROM events WHERE id = $1', [fixture.eventId]);
      await pool.query('DELETE FROM users WHERE id = $1', [fixture.userId]);
    }
  });

  afterAll(async () => {
    await postgres.closePostgresPool();
    await redis.closeRedis();
    if (originalPoolMax === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = originalPoolMax;
    if (originalPoolMin === undefined) delete process.env.DB_POOL_MIN;
    else process.env.DB_POOL_MIN = originalPoolMin;
  });

  async function createExpiredReservation(quantity: number, ageMinutes: number) {
    const eventId = uuid();
    const userId = uuid();
    const tierId = uuid();
    await pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      userId,
      `${userId}@sweeper.test`,
    ]);
    await pool.query(
      `INSERT INTO events (id, name, starts_at, ends_at, total_seats, available_seats, pricing, status)
       VALUES ($1, 'Sweeper test', NOW() + INTERVAL '1 hour', NOW() + INTERVAL '2 hours', 5, 5, $2, 'published')`,
      [eventId, JSON.stringify([{ id: tierId, name: 'General', price: 50, quantity: 5 }])],
    );
    const reservation = await new reservations.ReservationService().createReservation({
      eventId,
      userId,
      tierId,
      quantity,
    });
    fixtures.push({ id: reservation.id, eventId, userId });
    await pool.query(
      `UPDATE reservations SET expires_at = NOW() - ($2 * INTERVAL '1 minute') WHERE id = $1`,
      [reservation.id, ageMinutes],
    );
    return reservation;
  }

  async function snapshot(id: string) {
    const result = await pool.query(
      `SELECT r.status, e.available_seats FROM reservations r
       JOIN events e ON e.id = r.event_id WHERE r.id = $1`,
      [id],
    );
    return result.rows[0];
  }

  async function expectReleasedConnection() {
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1);
    expect(pool.waitingCount).toBe(0);
    await expect(pool.query('SELECT 1')).resolves.toMatchObject({ rowCount: 1 });
  }

  it('expires a held reservation, restores inventory, and leaves repeat/empty sweeps harmless', async () => {
    const reservation = await createExpiredReservation(2, 1);
    expect(await snapshot(reservation.id)).toEqual({ status: 'active', available_seats: 3 });
    expect(await holds.getReservationHold(reservation.id)).not.toBeNull();

    await expect(sweeper.sweepExpiredReservations()).resolves.toBe(1);

    expect(await snapshot(reservation.id)).toEqual({ status: 'expired', available_seats: 5 });
    expect(await holds.getReservationHold(reservation.id)).toBeNull();
    await expect(sweeper.sweepExpiredReservations()).resolves.toBe(0);
    expect(await snapshot(reservation.id)).toEqual({ status: 'expired', available_seats: 5 });
    await expectReleasedConnection();
  }, 30000);

  it('rolls back a failed expiry, continues to the later reservation, and releases its connection', async () => {
    const failed = await createExpiredReservation(1, 2);
    const later = await createExpiredReservation(2, 1);
    // Simulate an inconsistent hold: returning its seat violates the real DB ceiling constraint.
    await pool.query('UPDATE events SET available_seats = 5 WHERE id = $1', [failed.eventId]);

    await expect(sweeper.sweepExpiredReservations()).resolves.toBe(1);

    expect(await snapshot(failed.id)).toEqual({ status: 'active', available_seats: 5 });
    expect(await holds.getReservationHold(failed.id)).not.toBeNull();
    expect(await snapshot(later.id)).toEqual({ status: 'expired', available_seats: 5 });
    expect(await holds.getReservationHold(later.id)).toBeNull();
    await expectReleasedConnection();
  }, 30000);
});
