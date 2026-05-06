import { PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';
import Decimal from 'decimal.js';
import { Order, CreateOrderInput } from '../models/order';
import { Ticket } from '../models/ticket';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
} from '../errors';
import { ReservationService } from './reservation.service';
import { InventoryService } from './inventory.service';
import { OrderService } from './order.service';
import { TicketService } from './ticket.service';
import { getLogger } from '@/infra/logger';

export interface CheckoutResult {
  order: Order;
  tickets: Ticket[];
}

/**
 * Checkout 명령 흐름 서비스.
 *
 * 이 서비스의 책임:
 *   - 동일 idempotency_key 동시 진입을 advisory lock으로 직렬화
 *   - 동일 idempotency_key 재사용 시 payload fingerprint 일치 검증
 *   - reservation 경유 시 reservation 검증+converted 전환을 atomic UPDATE로 처리
 *   - event 행을 FOR UPDATE로 잠그고 tier/가격 검증
 *   - order INSERT, payment_record INSERT(pending), 좌석 차감/이전
 *
 * 결제 settlement webhook 처리는 PaymentWebhookService에 분리되어 있다.
 * Order/Ticket 조회는 OrderService/TicketService에 분리되어 있다.
 */
export class CheckoutService {
  private logger = getLogger();
  private reservationService = new ReservationService();
  private inventory = new InventoryService();
  private orderService = new OrderService();
  private ticketService = new TicketService();

  async checkout(input: CreateOrderInput, client: PoolClient): Promise<CheckoutResult> {
    // 동일 idempotency_key 동시 진입 race를 차단한다.
    //
    // 문제 시나리오: Redis idempotency lock이 1차 layer지만 Redis 장애 시
    //   middleware가 lock 없이 통과시킨다. 그 상태에서 같은 key 두 요청이
    //   동시에 트랜잭션을 시작하면 둘 다 getOrderByIdempotencyKey에서 null을
    //   받고 둘 다 INSERT까지 진행한다. 한쪽은 idempotency_key UNIQUE 제약
    //   (23505)으로 깨지고, retry 대상도 아니므로 500으로 새어나간다.
    //
    // 해결: pg_advisory_xact_lock으로 idempotency_key 단위 mutual exclusion.
    //
    // 면접용 컨텍스트: hashtext()는 int4(32-bit)라 birthday paradox 기준 서로 다른
    // idempotency key가 약 6.5만 개 누적되면 충돌 확률이 ~50%까지 오른다. 충돌은
    // correctness bug는 아니지만 무관한 checkout이 같은 advisory lock queue에 묶여
    // contention을 만든다. PG 11+의 hashtextextended(text, seed)는 bigint를 반환하므로
    // advisory lock 키 공간을 64-bit로 넓힌다.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [input.idempotencyKey],
    );

    const existingOrder = await this.orderService.getOrderByIdempotencyKey(
      input.idempotencyKey,
      client,
    );
    if (existingOrder) {
      // Idempotency-Key 재사용 시 payload fingerprint 검증.
      //
      // 같은 key로 *다른* payload가 들어오는 건 의도된 멱등성이 아니다 (key 재사용 사고
      // 또는 악의적 우회 시도). 이 경우 기존 주문을 그대로 반환하면 클라이언트가 보낸
      // 의도와 다른 응답이 나가므로 더 위험하다 — 명시적으로 409로 거부한다.
      //
      // 비교 대상은 checkout의 결정요소(누가/무엇을/얼마나/어떤 reservation 기반인지)에
      // 한정. unit_price/total_amount는 server-side 계산이므로 입력으로 비교하지 않는다.
      const reservationMismatch =
        (existingOrder.reservationId ?? null) !== (input.reservationId ?? null);
      if (
        existingOrder.userId !== input.userId ||
        existingOrder.eventId !== input.eventId ||
        existingOrder.tierId !== input.tierId ||
        existingOrder.quantity !== input.quantity ||
        reservationMismatch
      ) {
        this.logger.warn(
          {
            idempotencyKey: input.idempotencyKey,
            existingOrderId: existingOrder.id,
            existingUserId: existingOrder.userId,
            requestedUserId: input.userId,
            existingEventId: existingOrder.eventId,
            requestedEventId: input.eventId,
          },
          'Idempotency-Key reused with different payload',
        );
        throw new ConflictError(
          'Idempotency-Key reused with a different request payload',
        );
      }

      this.logger.warn(
        { idempotencyKey: input.idempotencyKey },
        'Duplicate checkout request detected',
      );
      const tickets = await this.ticketService.getTicketsByOrderId(existingOrder.id, client);
      return { order: existingOrder, tickets };
    }

    // reservation을 사용한다면 검증+convert를 atomic UPDATE로 처리한다.
    //
    // 이 패턴이 중요한 이유:
    //   - "valid 체크 → checkout → convert" 3단계는 그 사이에 다른 트랜잭션이
    //     reservation을 release/expire 시킬 수 있어 race condition이 생긴다.
    //   - UPDATE ... WHERE status='active' AND expires_at > NOW() RETURNING은
    //     row lock + 조건 검증 + 상태 전환을 한 쿼리로 묶는다.
    //   - affected = 0이면 invalid (released/expired/만료시간 초과/payload mismatch).
    let seatsAlreadyHeld = false;
    if (input.reservationId) {
      const convertResult = await client.query(
        `UPDATE reservations
         SET status = 'converted'
         WHERE id = $1
           AND user_id = $2
           AND event_id = $3
           AND tier_id = $4
           AND quantity = $5
           AND status = 'active'
           AND expires_at > NOW()
         RETURNING id, user_id, event_id, tier_id, quantity`,
        [input.reservationId, input.userId, input.eventId, input.tierId, input.quantity],
      );

      if (convertResult.rowCount === 0) {
        const reservationCheck = await client.query(
          `SELECT user_id, event_id, tier_id, quantity, status, expires_at FROM reservations WHERE id = $1`,
          [input.reservationId],
        );
        if (reservationCheck.rows.length === 0) {
          throw new NotFoundError('Reservation', input.reservationId);
        }
        const r = reservationCheck.rows[0];
        if (r.status !== 'active' || new Date(r.expires_at) <= new Date()) {
          await this.reservationService.expireReservationWithClient(input.reservationId, client);
          throw new ConflictError('Reservation has expired or is no longer valid');
        }
        this.logger.warn(
          {
            reservationId: input.reservationId,
            reservationUserId: r.user_id,
            checkoutUserId: input.userId,
            reservationEventId: r.event_id,
            checkoutEventId: input.eventId,
          },
          'Checkout payload does not match reservation',
        );
        throw new ConflictError('Checkout payload does not match reservation');
      }

      seatsAlreadyHeld = true;
    }

    // events row를 INSERT 이전에 FOR UPDATE로 일찍 잠근다.
    //
    // 이유: orders가 events를 FK로 참조하므로 INSERT INTO orders는
    // events row에 *암묵적 SHARE lock*을 건다. 이 SHARE lock 상태에서
    // 뒤에 InventoryService.adjustAvailableSeats가 FOR UPDATE를 시도하면
    // 동시 트랜잭션끼리 서로의 SHARE lock 해제를 기다리며 deadlock(40P01)이
    // 발생한다. 첫 SELECT 시점에 FOR UPDATE를 명시해 모든 동시 트랜잭션이
    // 같은 lock 순서를 따르도록 직렬화한다.
    const eventResult = await client.query<{
      id: string;
      pricing: Array<{ id: string; price: number }>;
    }>(
      `SELECT
         id,
         pricing::jsonb as "pricing"
       FROM events
       WHERE id = $1
       FOR UPDATE`,
      [input.eventId],
    );

    if (eventResult.rows.length === 0) {
      throw new NotFoundError('Event', input.eventId);
    }

    const event = eventResult.rows[0];

    const tier = event.pricing.find((candidate) => candidate.id === input.tierId);
    if (!tier) {
      throw new ValidationError(`Pricing tier not found: ${input.tierId}`);
    }

    const unitPrice = new Decimal(tier.price);
    const totalAmount = unitPrice.times(input.quantity);

    this.logger.debug(
      {
        eventId: input.eventId,
        quantity: input.quantity,
        unitPrice: unitPrice.toString(),
        totalAmount: totalAmount.toString(),
      },
      'Calculated checkout pricing',
    );

    const orderId = uuid();
    const orderResult = await client.query<Order>(
      `INSERT INTO orders (
         id, user_id, event_id, quantity, tier_id, unit_price, total_amount,
         idempotency_key, reservation_id, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
       RETURNING
         id, user_id as "userId", event_id as "eventId", quantity,
         tier_id as "tierId", unit_price as "unitPrice", total_amount as "totalAmount",
         status, idempotency_key as "idempotencyKey",
         reservation_id as "reservationId",
         created_at as "createdAt", updated_at as "updatedAt"`,
      [
        orderId,
        input.userId,
        input.eventId,
        input.quantity,
        input.tierId,
        unitPrice.toString(),
        totalAmount.toString(),
        input.idempotencyKey,
        input.reservationId || null,
      ],
    );

    const order = orderResult.rows[0];

    if (!seatsAlreadyHeld) {
      const newAvailable = await this.inventory.adjustAvailableSeats(
        input.eventId,
        -input.quantity,
        client,
      );

      this.logger.info(
        {
          orderId,
          eventId: input.eventId,
          seatsDeducted: input.quantity,
          newAvailable,
        },
        'Inventory deducted for checkout (no reservation)',
      );
    } else {
      this.logger.info(
        {
          orderId,
          eventId: input.eventId,
          reservationId: input.reservationId,
          seatsTransferred: input.quantity,
        },
        'Inventory transferred from reservation hold to order',
      );
    }

    const paymentRecordId = uuid();
    await client.query(
      `INSERT INTO payment_records (id, order_id, status, idempotency_key)
       VALUES ($1, $2, 'pending', $3)`,
      [paymentRecordId, orderId, input.idempotencyKey],
    );

    this.logger.info({ orderId, status: 'pending' }, 'Order created successfully');

    return { order, tickets: [] };
  }
}
