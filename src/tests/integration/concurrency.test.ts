import {
  initPostgresPool,
  closePostgresPool,
  serializableTransactionWithRetry,
} from '@/infra/postgres/client';
import { initRedis, closeRedis, getRedis } from '@/infra/redis/client';
import { loadConfig } from '@/infra/config';
import { initLogger } from '@/infra/logger';
import { v4 as uuid } from 'uuid';
import { CheckoutService } from '@/core/services/checkout.service';
import { ReservationService } from '@/core/services/reservation.service';

type CheckoutInput = {
  eventId: string;
  userId: string;
  quantity: number;
  tierId: string;
  idempotencyKey: string;
  reservationId?: string;
};

describe('concurrency integration tests', () => {
  let pool: Awaited<ReturnType<typeof initPostgresPool>>;

  async function clearTestData() {
    await pool.query('DELETE FROM tickets');
    await pool.query('DELETE FROM payment_records');
    await pool.query('DELETE FROM orders');
    await pool.query('DELETE FROM reservations');
    await pool.query('DELETE FROM events');
    await pool.query('DELETE FROM users');
  }

  /**
   * Redis에 남아 있는 테스트 키를 정리한다.
   * reservation hold / idempotency / rate limit 등이 테스트 간 누수되지 않도록 한다.
   */
  async function clearRedisData() {
    const redis = getRedis();
    const keys = await redis.keys('peakpass:*');
    if (keys.length === 0) return;
    await Promise.all(keys.map((key) => redis.del(key)));
  }

  /**
   * 테스트용 이벤트 + n명의 사용자를 만들어주는 헬퍼.
  /**
   * 테스트용 이벤트 + n명의 사용자를 만들어주는 헬퍼.
   */
  async function setupEventAndUsers(opts: {
    seats: number;
    userCount: number;
  }): Promise<{ eventId: string; tierId: string; userIds: string[] }> {
    const eventId = uuid();
    const tierId = uuid();
    const now = new Date();
    const startsAt = new Date(now.getTime() + 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);

    await pool.query(
      `
      INSERT INTO events (id, name, starts_at, ends_at, total_seats, available_seats, pricing, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'published')
      `,
      [
        eventId,
        'Concurrency test event',
        startsAt,
        endsAt,
        opts.seats,
        opts.seats,
        JSON.stringify([
          {
            id: tierId,
            name: 'General',
            price: 50,
            quantity: opts.seats,
          },
        ]),
      ],
    );

    const userIds = Array.from({ length: opts.userCount }, () => uuid());

    await Promise.all(
      userIds.map((userId) =>
        pool.query(
          `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`,
          [
            userId,
            `user-${userId.slice(0, 8)}@test.com`,
            `Test user ${userId.slice(0, 4)}`,
          ],
        ),
      ),
    );

    return { eventId, tierId, userIds };
  }

  async function getAvailableSeats(eventId: string): Promise<number> {
    const result = await pool.query(
      `SELECT available_seats FROM events WHERE id = $1`,
      [eventId],
    );
    return result.rows[0].available_seats;
  }

  async function getReservationStatus(reservationId: string): Promise<string | null> {
    const result = await pool.query(
      `SELECT status FROM reservations WHERE id = $1`,
      [reservationId],
    );
    return result.rows[0]?.status ?? null;
  }

  beforeAll(async () => {
    loadConfig();
    initLogger();
    pool = await initPostgresPool();
    await initRedis();
  });

  afterAll(async () => {
    await closeRedis();
    await closePostgresPool();
  });

  beforeEach(async () => {
    await clearTestData();
    await clearRedisData();
  });

  afterEach(async () => {
    await clearTestData();
    await clearRedisData();
  });

  it(
    'prevents overselling under concurrent serializable checkouts',
    async () => {
      const { eventId, tierId, userIds } = await setupEventAndUsers({
        seats: 3,
        userCount: 5,
      });

      const checkoutService = new CheckoutService();

      const results = await Promise.allSettled(
        userIds.map((userId) => {
          const input: CheckoutInput = {
            eventId,
            userId,
            quantity: 1,
            tierId,
            idempotencyKey: uuid(),
          };

          return serializableTransactionWithRetry((client) =>
            checkoutService.checkout(input, client),
          );
        }),
      );

      const successCount = results.filter((r) => r.status === 'fulfilled').length;
      const failureCount = results.filter((r) => r.status === 'rejected').length;

      expect(successCount).toBe(3);
      expect(failureCount).toBe(2);
      expect(await getAvailableSeats(eventId)).toBe(0);
    },
    15000,
  );

  it(
    'prevents overselling at reservation stage under concurrent reservations',
    async () => {
      // 좌석 3개에 5명이 동시에 reservation을 시도하면
      // reservation 단계 자체에서 3명만 성공해야 한다 (oversell 차단).
      // 이전 구현은 reservation이 좌석을 차감하지 않아 5명 모두 성공했다.
      const { eventId, tierId, userIds } = await setupEventAndUsers({
        seats: 3,
        userCount: 5,
      });

      const reservationService = new ReservationService();

      const results = await Promise.allSettled(
        userIds.map((userId) =>
          reservationService.createReservation({
            eventId,
            userId,
            quantity: 1,
            tierId,
          }),
        ),
      );

      const successCount = results.filter((r) => r.status === 'fulfilled').length;
      const failureCount = results.filter((r) => r.status === 'rejected').length;

      expect(successCount).toBe(3);
      expect(failureCount).toBe(2);
      expect(await getAvailableSeats(eventId)).toBe(0);
    },
    15000,
  );

  it(
    'returns seats to inventory when a reservation is expired',
    async () => {
      // reservation 생성 → 좌석 차감 → expire 호출 → 좌석 원복.
      const { eventId, tierId, userIds } = await setupEventAndUsers({
        seats: 5,
        userCount: 1,
      });
      const userId = userIds[0];

      const reservationService = new ReservationService();

      const reservation = await reservationService.createReservation({
        eventId,
        userId,
        quantity: 2,
        tierId,
      });

      // reservation 시점에 좌석이 차감됐는지 확인 (5 - 2 = 3)
      expect(await getAvailableSeats(eventId)).toBe(3);
      expect(await getReservationStatus(reservation.id)).toBe('active');

      // expire 호출 — 좌석 원복 + status 'expired'
      await reservationService.expireReservation(reservation.id);

      expect(await getAvailableSeats(eventId)).toBe(5);
      expect(await getReservationStatus(reservation.id)).toBe('expired');

      // expire를 한 번 더 호출해도 추가 원복이 일어나면 안 됨 (멱등성 검증)
      await reservationService.expireReservation(reservation.id);
      expect(await getAvailableSeats(eventId)).toBe(5);
    },
    15000,
  );

  it(
    'does not double-deduct seats when checkout follows a reservation',
    async () => {
      // reservation에서 좌석 차감 → checkout이 그 reservation을 사용 → 좌석 추가 차감 없음.
      // 이전 구현은 reservation은 차감 안 하고 checkout만 차감했지만,
      // 새 구현에서는 reservation에서 차감하고 checkout은 그 점유를 *이전*만 한다.
      const { eventId, tierId, userIds } = await setupEventAndUsers({
        seats: 5,
        userCount: 1,
      });
      const userId = userIds[0];

      const reservationService = new ReservationService();
      const checkoutService = new CheckoutService();

      const reservation = await reservationService.createReservation({
        eventId,
        userId,
        quantity: 2,
        tierId,
      });

      // reservation 후: 5 - 2 = 3
      expect(await getAvailableSeats(eventId)).toBe(3);

      // reservation을 사용한 checkout
      await serializableTransactionWithRetry((client) =>
        checkoutService.checkout(
          {
            eventId,
            userId,
            quantity: 2,
            tierId,
            reservationId: reservation.id,
            idempotencyKey: uuid(),
          },
          client,
        ),
      );

      // checkout 후에도 좌석은 그대로 3 — 이중 차감 없음
      expect(await getAvailableSeats(eventId)).toBe(3);

      // reservation은 'converted' 상태
      expect(await getReservationStatus(reservation.id)).toBe('converted');
    },
    15000,
  );
});