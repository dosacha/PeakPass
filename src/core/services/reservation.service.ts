import { PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';
import { Reservation, CreateReservationInput } from '../models/reservation';
import { InsufficientInventoryError, NotFoundError } from '../errors';
import {
  deleteReservationHold,
  getReservationHold,
  REDIS_TTL,
  setReservationHold,
} from '@/infra/redis/commands';
import { getLogger } from '@/infra/logger';
import { getPostgresPool } from '@/infra/postgres/client';

const RESERVATION_TTL_SECONDS = REDIS_TTL.RESERVATION_HOLD;

export class ReservationService {
  private logger = getLogger();

  async createReservation(input: CreateReservationInput): Promise<Reservation> {
    const pool = getPostgresPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const reservation = await this.createReservationWithClient(input, client);
      await client.query('COMMIT');
      await this.cacheReservationHold(reservation);
      return reservation;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async createReservationWithClient(
    input: CreateReservationInput,
    client: PoolClient,
  ): Promise<Reservation> {
    const eventResult = await client.query<{ available_seats: number }>(
      'SELECT available_seats FROM events WHERE id = $1',
      [input.eventId],
    );

    if (eventResult.rows.length === 0) {
      throw new NotFoundError('Event', input.eventId);
    }

    const { available_seats } = eventResult.rows[0];
    if (available_seats < input.quantity) {
      throw new InsufficientInventoryError(available_seats, input.quantity);
    }

    const reservationId = uuid();
    const expiresAt = new Date(Date.now() + RESERVATION_TTL_SECONDS * 1000);

    const result = await client.query<Reservation>(
      `
      INSERT INTO reservations (id, user_id, event_id, quantity, tier_id, expires_at, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'active')
      RETURNING
        id, user_id as "userId", event_id as "eventId",
        quantity, tier_id as "tierId", expires_at as "expiresAt",
        status, created_at as "createdAt", updated_at as "updatedAt"
      `,
      [reservationId, input.userId, input.eventId, input.quantity, input.tierId, expiresAt],
    );

    const reservation = result.rows[0];

    this.logger.info(
      {
        reservationId,
        eventId: input.eventId,
        quantity: input.quantity,
        ttlSeconds: RESERVATION_TTL_SECONDS,
      },
      'Reservation created',
    );

    return reservation;
  }

  async getReservation(reservationId: string): Promise<Reservation | null> {
    const pool = getPostgresPool();
    const client = await pool.connect();

    try {
      return await this.getReservationWithClient(reservationId, client);
    } finally {
      client.release();
    }
  }

  async getReservationWithClient(
    reservationId: string,
    client: PoolClient,
  ): Promise<Reservation | null> {
    const redisData = await getReservationHold(reservationId);
    if (redisData) {
      this.logger.debug({ reservationId }, 'Reservation found in Redis');
      return redisData as Reservation;
    }

    const result = await client.query<Reservation>(
      `
      SELECT
        id, user_id as "userId", event_id as "eventId",
        quantity, tier_id as "tierId", expires_at as "expiresAt",
        status, created_at as "createdAt", updated_at as "updatedAt"
      FROM reservations
      WHERE id = $1
      `,
      [reservationId],
    );

    return result.rows[0] || null;
  }

  async isReservationValid(reservationId: string): Promise<boolean> {
    const pool = getPostgresPool();
    const client = await pool.connect();

    try {
      return await this.isReservationValidWithClient(reservationId, client);
    } finally {
      client.release();
    }
  }

  async isReservationValidWithClient(reservationId: string, client: PoolClient): Promise<boolean> {
    const redisData = await getReservationHold(reservationId);
    if (redisData) {
      return redisData.status === 'active';
    }

    const result = await client.query<{ valid: boolean }>(
      `
      SELECT
        CASE
          WHEN status = 'active' AND expires_at > NOW() THEN true
          ELSE false
        END as valid
      FROM reservations
      WHERE id = $1
      `,
      [reservationId],
    );

    return result.rows[0]?.valid ?? false;
  }

  async releaseReservation(reservationId: string): Promise<void> {
    const pool = getPostgresPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await this.releaseReservationWithClient(reservationId, client);
      await client.query('COMMIT');
      await deleteReservationHold(reservationId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async releaseReservationWithClient(reservationId: string, client: PoolClient): Promise<void> {
    await client.query('UPDATE reservations SET status = $1 WHERE id = $2', ['released', reservationId]);
    this.logger.info({ reservationId }, 'Reservation released');
  }

  async convertReservation(reservationId: string): Promise<void> {
    const pool = getPostgresPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await this.convertReservationWithClient(reservationId, client);
      await client.query('COMMIT');
      await deleteReservationHold(reservationId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async convertReservationWithClient(reservationId: string, client: PoolClient): Promise<void> {
    await client.query('UPDATE reservations SET status = $1 WHERE id = $2', ['converted', reservationId]);
    this.logger.info({ reservationId }, 'Reservation converted to order');
  }

  private async cacheReservationHold(reservation: Reservation): Promise<void> {
    await setReservationHold(reservation.id, reservation, RESERVATION_TTL_SECONDS);
  }
}
