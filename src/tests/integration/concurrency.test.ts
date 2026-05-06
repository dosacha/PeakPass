import {
  initPostgresPool,
  closePostgresPool,
  serializableTransactionWithRetry,
} from '@/infra/postgres/client';
import { initRedis, closeRedis, getRedis } from '@/infra/redis/client';
import { loadConfig } from '@/infra/config';
import { initLogger } from '@/infra/logger';
import { v4 as uuid } from 'uuid';
import { CheckoutService, CheckoutResult } from '@/core/services/checkout.service';
import { ReservationService } from '@/core/services/reservation.service';
import { ConflictError, ValidationError } from '@/core/errors';

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
    await closePostgresPool();
    await closeRedis();
  });

  beforeEach(async () => {
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

      expect(await getAvailableSeats(eventId)).toBe(3);
      expect(await getReservationStatus(reservation.id)).toBe('active');

      await reservationService.expireReservation(reservation.id);

      expect(await getAvailableSeats(eventId)).toBe(5);
      expect(await getReservationStatus(reservation.id)).toBe('expired');

      await reservationService.expireReservation(reservation.id);
      expect(await getAvailableSeats(eventId)).toBe(5);
    },
    15000,
  );

  it(
    'does not double-deduct seats when checkout follows a reservation',
    async () => {
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

      expect(await getAvailableSeats(eventId)).toBe(3);

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

      expect(await getAvailableSeats(eventId)).toBe(3);

      expect(await getReservationStatus(reservation.id)).toBe('converted');
    },
    15000,
  );

  it(
    'rejects checkout when userId differs from reservation',
    async () => {
      const reservationService = new ReservationService();
      const checkoutService = new CheckoutService();
      const { eventId, tierId, userIds } = await setupEventAndUsers({
        seats: 5,
        userCount: 2,
      });

      const reservation = await reservationService.createReservation({
        eventId,
        userId: userIds[0],
        quantity: 1,
        tierId,
      });

      await expect(
        serializableTransactionWithRetry((client) =>
          checkoutService.checkout(
            {
              eventId,
              userId: userIds[1],
              quantity: 1,
              tierId,
              reservationId: reservation.id,
              idempotencyKey: uuid(),
            },
            client,
          ),
        ),
      ).rejects.toThrow(ConflictError);

      expect(await getReservationStatus(reservation.id)).toBe('active');
      expect(await getAvailableSeats(eventId)).toBe(4);
    },
    15000,
  );

  it(
    'rejects checkout when quantity differs from reservation',
    async () => {
      const reservationService = new ReservationService();
      const checkoutService = new CheckoutService();
      const { eventId, tierId, userIds } = await setupEventAndUsers({
        seats: 5,
        userCount: 1,
      });

      const reservation = await reservationService.createReservation({
        eventId,
        userId: userIds[0],
        quantity: 2,
        tierId,
      });

      await expect(
        serializableTransactionWithRetry((client) =>
          checkoutService.checkout(
            {
              eventId,
              userId: userIds[0],
              quantity: 5,
              tierId,
              reservationId: reservation.id,
              idempotencyKey: uuid(),
            },
            client,
          ),
        ),
      ).rejects.toThrow(ConflictError);
    },
    15000,
  );

  // concurrency.test.ts에 추가 권장
  it('returns idempotent order when same idempotency_key arrives concurrently', async () => {
    const { eventId, tierId, userIds } = await setupEventAndUsers({ seats: 5, userCount: 1 });
    const idempotencyKey = uuid();

    const checkoutService = new CheckoutService();
    const input = {
      eventId,
      userId: userIds[0],
      quantity: 1,
      tierId,
      idempotencyKey,
    };

    const results = await Promise.allSettled([
      serializableTransactionWithRetry((c) => checkoutService.checkout(input, c)),
      serializableTransactionWithRetry((c) => checkoutService.checkout(input, c)),
      serializableTransactionWithRetry((c) => checkoutService.checkout(input, c)),
    ]);

    // 셋 다 fulfilled여야 한다 (advisory lock으로 23505 발생 안 함)
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    // 셋 다 같은 order id를 받아야 한다 (idempotent)
    const orderIds = results
      .filter((r): r is PromiseFulfilledResult<CheckoutResult> => r.status === 'fulfilled')
      .map((r) => r.value.order.id);
    expect(new Set(orderIds).size).toBe(1);

    // 좌석은 1개만 차감
    expect(await getAvailableSeats(eventId)).toBe(4);
  });

  // reservation tier 검증 (concurrency.test.ts에 추가 권장)
  it('rejects reservation when tier_id does not exist in event.pricing', async () => {
    const { eventId, userIds } = await setupEventAndUsers({ seats: 5, userCount: 1 });
    const reservationService = new ReservationService();

    await expect(
      reservationService.createReservation({
        eventId,
        userId: userIds[0],
        quantity: 1,
        tierId: 'non-existent-tier-id',
      }),
    ).rejects.toThrow(ValidationError);

    // 좌석은 차감되지 않아야 함
    expect(await getAvailableSeats(eventId)).toBe(5);
  });

  it(
    'rejects checkout when same idempotency_key is reused with different payload',
    async () => {
      const { eventId, tierId, userIds } = await setupEventAndUsers({
        seats: 5,
        userCount: 1,
      });
      const idempotencyKey = uuid();
      const checkoutService = new CheckoutService();

      const firstInput: CheckoutInput = {
        eventId,
        userId: userIds[0],
        quantity: 1,
        tierId,
        idempotencyKey,
      };
      const firstResult = await serializableTransactionWithRetry((client) =>
        checkoutService.checkout(firstInput, client),
      );
      expect(firstResult.order.quantity).toBe(1);

      // 같은 idempotency_key, 다른 quantity → 409 (ConflictError)
      const conflictingInput: CheckoutInput = {
        eventId,
        userId: userIds[0],
        quantity: 3,
        tierId,
        idempotencyKey,
      };

      await expect(
        serializableTransactionWithRetry((client) =>
          checkoutService.checkout(conflictingInput, client),
        ),
      ).rejects.toThrow(ConflictError);

      // 같은 key + 같은 payload는 여전히 idempotent해야 함
      const idempotentResult = await serializableTransactionWithRetry((client) =>
        checkoutService.checkout(firstInput, client),
      );
      expect(idempotentResult.order.id).toBe(firstResult.order.id);

      // 좌석은 1개만 차감되어 있어야 함
      expect(await getAvailableSeats(eventId)).toBe(4);
    },
    15000,
  );
});