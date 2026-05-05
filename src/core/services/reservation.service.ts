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

  /**
   * Reservation을 생성하면서 events.available_seats에서 좌석을 즉시 차감한다 (soft hold).
   *
   * 이전 구현은 SELECT만 하고 차감하지 않았기 때문에 reservation 단계에서
   * oversell이 차단되지 않았다 (좌석 1개에 두 사용자가 reservation을 모두 성공).
   *
   * 차감된 좌석은 다음 시점에 처리된다:
   *   - convert (checkout 성공): 좌석은 order로 점유 그대로 유지
   *   - release (사용자 취소): 좌석 원복 (+quantity)
   *   - expire (TTL 초과): 좌석 원복 (+quantity)
   */
  async createReservationWithClient(
    input: CreateReservationInput,
    client: PoolClient,
  ): Promise<Reservation> {
    // events 행을 명시적으로 잠궈서 동시 reservation/checkout과 직렬화한다.
    const eventResult = await client.query<{ available_seats: number }>(
      `SELECT available_seats FROM events WHERE id = $1 FOR UPDATE`,
      [input.eventId],
    );

    if (eventResult.rows.length === 0) {
      throw new NotFoundError('Event', input.eventId);
    }

    const { available_seats } = eventResult.rows[0];
    if (available_seats < input.quantity) {
      throw new InsufficientInventoryError(available_seats, input.quantity);
    }

    // 좌석 즉시 차감 (soft hold)
    await client.query(
      `UPDATE events SET available_seats = available_seats - $1 WHERE id = $2`,
      [input.quantity, input.eventId],
    );

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
        seatsHeld: input.quantity,
        ttlSeconds: RESERVATION_TTL_SECONDS,
      },
      'Reservation created with seat hold',
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

  /**
   * Reservation이 사용 가능한 상태인지만 확인한다 (부작용 없음).
   *
   * 만료를 발견해도 *좌석 원복은 하지 않는다*. 호출자(checkout 등)가
   * 만료된 reservation을 발견하면 명시적으로 expireReservation()을 호출해서
   * 좌석을 돌려놓아야 한다. 단순 GET 조회는 이 함수만으로 충분.
   */
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

  /**
   * 사용자가 명시적으로 reservation을 취소할 때 호출.
   * status가 'active'일 때만 좌석을 원복하고 'released'로 전환한다 (멱등).
   */
  async releaseReservationWithClient(reservationId: string, client: PoolClient): Promise<void> {
    await this.returnSeatsAndFinalize(reservationId, 'released', client);
  }

  async expireReservation(reservationId: string): Promise<void> {
    const pool = getPostgresPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await this.expireReservationWithClient(reservationId, client);
      await client.query('COMMIT');
      await deleteReservationHold(reservationId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * TTL 초과로 만료된 reservation을 정리하고 좌석을 원복한다.
   * isReservationValidWithClient가 false를 반환했을 때 호출자가 사용한다.
   */
  async expireReservationWithClient(reservationId: string, client: PoolClient): Promise<void> {
    await this.returnSeatsAndFinalize(reservationId, 'expired', client);
  }

  /**
   * release/expire 공통 로직.
   *
   * 1. reservation 행을 FOR UPDATE로 잠금
   * 2. status가 'active'가 아니면 noop (이중 release/expire 방어)
   * 3. events 행도 잠그고 좌석 원복
   * 4. reservation status 변경
   */
  private async returnSeatsAndFinalize(
    reservationId: string,
    finalStatus: 'released' | 'expired',
    client: PoolClient,
  ): Promise<void> {
    const result = await client.query<{
      event_id: string;
      quantity: number;
      status: string;
    }>(
      `
      SELECT event_id, quantity, status
      FROM reservations
      WHERE id = $1
      FOR UPDATE
      `,
      [reservationId],
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Reservation', reservationId);
    }

    const { event_id, quantity, status } = result.rows[0];

    if (status !== 'active') {
      this.logger.debug(
        { reservationId, currentStatus: status, attemptedStatus: finalStatus },
        'Reservation already finalized; skipping seat return',
      );
      return;
    }

    await client.query(`SELECT id FROM events WHERE id = $1 FOR UPDATE`, [event_id]);
    await client.query(
      `UPDATE events SET available_seats = available_seats + $1 WHERE id = $2`,
      [quantity, event_id],
    );

    await client.query(`UPDATE reservations SET status = $1 WHERE id = $2`, [
      finalStatus,
      reservationId,
    ]);

    this.logger.info(
      { reservationId, eventId: event_id, seatsReleased: quantity, finalStatus },
      'Reservation finalized and seats returned',
    );
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

  /**
   * checkout 성공 시 reservation을 'converted'로 전환.
   *
   * 좌석은 이미 reservation 시점에 차감되어 있으므로 *원복하지 않는다*.
   * 차감된 좌석은 그대로 order의 점유로 이전된다 (checkout이
   * reservation_id를 받으면 좌석 차감을 skip해야 한다 — 2단계에서 처리).
   *
   * WHERE status = 'active' 조건으로 이중 convert를 방어한다.
   */
  async convertReservationWithClient(reservationId: string, client: PoolClient): Promise<void> {
    const result = await client.query(
      `UPDATE reservations SET status = 'converted' WHERE id = $1 AND status = 'active'`,
      [reservationId],
    );

    if (result.rowCount === 0) {
      this.logger.debug(
        { reservationId },
        'Reservation already converted/finalized; skipping convert',
      );
      return;
    }

    this.logger.info({ reservationId }, 'Reservation converted to order');
  }

  private async cacheReservationHold(reservation: Reservation): Promise<void> {
    await setReservationHold(reservation.id, reservation, RESERVATION_TTL_SECONDS);
  }
}