import { PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';
import { Reservation, CreateReservationInput } from '../models/reservation';
import { NotFoundError, ValidationError } from '../errors';
import { InventoryService } from './inventory.service';
import {
  deleteReservationHold,
  getReservationHold,
  REDIS_TTL,
  setReservationHold,
} from '@/infra/redis/commands';
import { getLogger } from '@/infra/logger';
import { getPostgresPool } from '@/infra/postgres/client';

const RESERVATION_TTL_SECONDS = REDIS_TTL.RESERVATION_HOLD;

/**
 * Reservation 도메인 서비스.
 *
 * 흐름:
 *   - create: events 행 lock + 좌석 차감 + reservations INSERT + Redis hold 캐시
 *   - convert (checkout 시): UPDATE ... WHERE status='active' AND expires_at > NOW()
 *     atomic 쿼리. 이 경로는 본 서비스의 메서드를 *호출하지 않는다* — 호출자가
 *     트랜잭션 안에서 직접 실행 (CheckoutService.checkout)
 *   - release/expire: returnSeatsAndFinalize 공통 로직, 좌석 원복 + status 전환
 *
 * Redis hold 역할:
 *   - GET /reservations/:id 응답 가속 (getReservationWithClient에서 1회 read)
 *   - 클라이언트가 만료 시각을 빠르게 표시
 *
 *   *checkout 경로는 Redis hold를 읽지 않는다*. 정합성 판단은 모두 DB 트랜잭션
 *   안의 atomic UPDATE에서 이뤄진다. 이 사실을 명시하지 않으면 "hold가 정합성 layer
 *   인 줄 알았는데 아니네"라는 오해가 생긴다.
 */
export class ReservationService {
  private logger = getLogger();
  private inventory = new InventoryService();

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
    // tier_id가 events.pricing 안의 id와 일치하는지 진입 시점에 검증한다.
    //
    // 이 검증을 하지 않으면 무효한 tier_id로 reservation이 생성되어 좌석을 hold하고,
    // 그 후 checkout이 와서야 tier lookup 실패로 거부된다. 그 사이 좌석은 5분간
    // 점유된 상태로 남고 sweeper가 풀어줄 때까지 다른 사용자의 reservation을 막는다.
    // 단순한 입력 검증이지만 작은 DoS 벡터를 차단하는 의미가 있다.
    //
    // events.pricing은 event 생성 시 박히고 사실상 immutable이므로 plain SELECT로
    // 충분하다. FOR UPDATE는 뒤이은 inventory.adjustAvailableSeats가 잡는다.
    const tierCheckResult = await client.query<{ pricing: Array<{ id: string }> }>(
      `SELECT pricing::jsonb as "pricing" FROM events WHERE id = $1`,
      [input.eventId],
    );
    if (tierCheckResult.rows.length === 0) {
      throw new NotFoundError('Event', input.eventId);
    }
    const tierExists = tierCheckResult.rows[0].pricing.some(
      (tier) => tier.id === input.tierId,
    );
    if (!tierExists) {
      throw new ValidationError(`Pricing tier not found: ${input.tierId}`);
    }

    // events 행을 명시적으로 잠궈서 동시 reservation/checkout과 직렬화한다.
    await this.inventory.adjustAvailableSeats(input.eventId, -input.quantity, client);

    // 좌석 즉시 차감 (soft hold)
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

  /**
   * Reservation 단건 조회 (GET /reservations/:id 등 외부 read 경로용).
   *
   * Redis hold 우선, DB fallback. Redis hold는 createReservation의 commit 직후
   * 적재되며 release/expire/convert 트랜잭션 commit 직후에 삭제된다. TTL 만료 시에도
   * 자동 소거된다.
   *
   * 주의: 이 함수는 *조회 가속*이 목적이다. checkout 흐름의 정합성 판단은 본 함수를
   * 거치지 않고 DB 트랜잭션 안의 atomic UPDATE에서 이뤄진다 (CheckoutService.checkout
   * 의 reservation convert 쿼리). 즉 Redis hold가 stale해도 정합성에는 영향이 없고,
   * 사용자가 GET 응답에서 잠깐 stale한 expiresAt을 볼 수 있는 정도가 최악의 시나리오다.
   *
   * Redis 장애 시 DB로 폴백하므로 이 경로는 fail-safe하다.
   */
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
   * sweeper와 checkout의 lazy expire 경로에서 호출된다.
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

    await this.inventory.adjustAvailableSeats(event_id, quantity, client);

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
   * 본 메서드는 현재 시점에는 *호출되지 않는다*. CheckoutService.checkout이
   * reservation convert를 atomic UPDATE 한 쿼리(WHERE status='active' AND
   * expires_at > NOW() RETURNING)로 직접 처리한다 — 이게 race condition을 더
   * 좁게 막는 패턴이라서. 본 메서드는 CheckoutService 외부에서 *명시적*으로
   * reservation을 convert하고 싶은 경우 (어드민 도구, 데이터 보정 작업 등)를
   * 위해 남겨둔다.
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