import { PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';
import Decimal from 'decimal.js';
import { Order, CreateOrderInput } from '../models/order';
import { Ticket, generateTicketNumber } from '../models/ticket';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
} from '../errors';
import { ReservationService } from './reservation.service';
import { InventoryService } from './inventory.service';
import { getLogger } from '@/infra/logger';
import { PaymentWebhookInput } from '../models/payment';

export interface CheckoutResult {
  order: Order;
  tickets: Ticket[];
}

type PaymentTransition =
  | { kind: 'settle' }
  | { kind: 'fail' };

type WebhookOutcome =
  | { kind: 'idempotent_settled'; order: Order; tickets: Ticket[] }
  | { kind: 'idempotent_failed'; order: Order }
  | { kind: 'newly_settled'; order: Order; tickets: Ticket[] }
  | { kind: 'newly_failed'; order: Order }
  // fail webhook이 도착했지만 order는 이미 paid 상태인 경우.
  // 응답 자체는 settled 응답과 동일하지만 *입력 의도와 outcome이 다르다*는
  // 사실을 audit log/내부 분기에서 구분하기 위해 별도 kind로 분리한다.
  | { kind: 'late_failure_after_settled'; order: Order; tickets: Ticket[] };

export class CheckoutService {
  private logger = getLogger();
  private reservationService = new ReservationService();
  private inventory = new InventoryService();

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
    //   - hashtext: 64-bit hash, 충돌 가능성 무시 가능
    //   - xact_lock: 트랜잭션 종료 시 자동 해제, 별도 release 필요 없음
    //   - 늦게 도착한 트랜잭션은 lock을 기다린 후 SELECT에서 기존 order 발견
    //
    // 결과: 23505 race window 자체가 제거되어 idempotent 응답이 일관되게 나간다.
    // DB UNIQUE constraint는 여전히 schema-level backup으로 남는다.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [input.idempotencyKey],
    );

    const existingOrder = await this.getOrderByIdempotencyKey(input.idempotencyKey, client);
    if (existingOrder) {
      this.logger.warn(
        { idempotencyKey: input.idempotencyKey },
        'Duplicate checkout request detected',
      );
      const tickets = await this.getTicketsByOrderId(existingOrder.id, client);
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
    //
    // reservation 단계에서 좌석은 이미 차감되어 있으므로 checkout은 좌석을 *추가 차감하지 않는다*.
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
        // 정확한 사유 분기
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
        // 여기까지 오면 payload mismatch
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
      `
      SELECT
        id,
        pricing::jsonb as "pricing"
      FROM events
      WHERE id = $1
      FOR UPDATE
      `,
      [input.eventId],
    );

    if (eventResult.rows.length === 0) {
      throw new NotFoundError('Event', input.eventId);
    }

    const event = eventResult.rows[0];

    // tier_id가 event.pricing 안에 존재하는지 검증.
    // reservation 경로에서도 reservation service가 진입 시점에 같은 검증을 수행하지만,
    // direct checkout (no reservation) 경로는 여기서만 검증된다.
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
      `
      INSERT INTO orders (
        id, user_id, event_id, quantity, tier_id, unit_price, total_amount,
        idempotency_key, reservation_id, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
      RETURNING
        id, user_id as "userId", event_id as "eventId", quantity,
        tier_id as "tierId", unit_price as "unitPrice", total_amount as "totalAmount",
        status, idempotency_key as "idempotencyKey",
        reservation_id as "reservationId",
        created_at as "createdAt", updated_at as "updatedAt"
      `,
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

    // 좌석 차감도 직접 checkout 경로에서만 한다.
    // reservation 경로의 좌석 점유는 그대로 order의 점유로 이전된다.
    // (events row는 위쪽 SELECT FOR UPDATE 시점에 이미 잠겨 있으므로
    //  여기서의 adjustAvailableSeats는 같은 트랜잭션의 lock을 재사용한다.)
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
      `
      INSERT INTO payment_records (id, order_id, status, idempotency_key)
      VALUES ($1, $2, 'pending', $3)
      `,
      [paymentRecordId, orderId, input.idempotencyKey],
    );

    this.logger.info({ orderId, status: 'pending' }, 'Order created successfully');

    return { order, tickets: [] };
  }

  async markOrderAsPaid(orderId: string, client: PoolClient): Promise<Order> {
    const result = await client.query<Order>(
      `
      UPDATE orders
      SET status = 'paid', paid_at = NOW()
      WHERE id = $1
      RETURNING
        id, user_id as "userId", event_id as "eventId", quantity,
        tier_id as "tierId", unit_price as "unitPrice", total_amount as "totalAmount",
        status, idempotency_key as "idempotencyKey",
        created_at as "createdAt", updated_at as "updatedAt", paid_at as "paidAt"
      `,
      [orderId],
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Order', orderId);
    }

    this.logger.info({ orderId }, 'Order marked as paid');
    return result.rows[0];
  }

  async cancelOrder(orderId: string, client: PoolClient): Promise<Order> {
    const result = await client.query<Order>(
      `
      UPDATE orders
      SET status = 'cancelled'
      WHERE id = $1
      RETURNING
        id, user_id as "userId", event_id as "eventId", quantity,
        tier_id as "tierId", unit_price as "unitPrice", total_amount as "totalAmount",
        status, idempotency_key as "idempotencyKey",
        reservation_id as "reservationId",
        created_at as "createdAt", updated_at as "updatedAt", paid_at as "paidAt"
      `,
      [orderId],
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Order', orderId);
    }

    this.logger.info({ orderId }, 'Order cancelled');
    return result.rows[0];
  }

  async getOrderById(orderId: string, client: PoolClient): Promise<Order | null> {
    const result = await client.query<Order>(
      `
      SELECT
        id, user_id as "userId", event_id as "eventId", quantity,
        tier_id as "tierId", unit_price as "unitPrice", total_amount as "totalAmount",
        status, idempotency_key as "idempotencyKey",
        created_at as "createdAt", updated_at as "updatedAt", paid_at as "paidAt"
      FROM orders WHERE id = $1
      `,
      [orderId],
    );

    return result.rows[0] || null;
  }

  async getOrderByIdForUpdate(orderId: string, client: PoolClient): Promise<Order | null> {
    const result = await client.query<Order>(
      `
      SELECT
        id, user_id as "userId", event_id as "eventId", quantity,
        tier_id as "tierId", unit_price as "unitPrice", total_amount as "totalAmount",
        status, idempotency_key as "idempotencyKey",
        reservation_id as "reservationId",
        created_at as "createdAt", updated_at as "updatedAt", paid_at as "paidAt"
      FROM orders
      WHERE id = $1
      FOR UPDATE
      `,
      [orderId],
    );

    return result.rows[0] || null;
  }

  async getOrderByIdempotencyKey(
    idempotencyKey: string,
    client: PoolClient,
  ): Promise<Order | null> {
    const result = await client.query<Order>(
      `
      SELECT
        id, user_id as "userId", event_id as "eventId", quantity,
        tier_id as "tierId", unit_price as "unitPrice", total_amount as "totalAmount",
        status, idempotency_key as "idempotencyKey",
        created_at as "createdAt", updated_at as "updatedAt", paid_at as "paidAt"
      FROM orders WHERE idempotency_key = $1
      `,
      [idempotencyKey],
    );

    return result.rows[0] || null;
  }

  async getTicketsByOrderId(orderId: string, client: PoolClient): Promise<Ticket[]> {
    const result = await client.query<Ticket>(
      `
      SELECT
        id, order_id as "orderId", event_id as "eventId", user_id as "userId",
        ticket_number as "ticketNumber",
        status, created_at as "createdAt", updated_at as "updatedAt"
      FROM tickets WHERE order_id = $1
      `,
      [orderId],
    );

    return result.rows;
  }

  async getOrdersByUserId(
    userId: string,
    limit: number,
    offset: number,
    client: PoolClient,
  ): Promise<Array<Order & { paymentStatus: string }>> {
    const result = await client.query <
      Order & { paymentStatus: string }
    >(
      `
      SELECT
        o.id,
        o.user_id as "userId",
        o.event_id as "eventId",
        o.quantity,
        o.tier_id as "tierId",
        o.unit_price as "unitPrice",
        o.total_amount as "totalAmount",
        o.status,
        o.idempotency_key as "idempotencyKey",
        o.reservation_id as "reservationId",
        COALESCE(pr.status, 'pending') as "paymentStatus",
        o.created_at as "createdAt",
        o.updated_at as "updatedAt",
        o.paid_at as "paidAt"
      FROM orders o
      LEFT JOIN LATERAL (
        SELECT status
        FROM payment_records
        WHERE order_id = o.id
        ORDER BY created_at DESC
        LIMIT 1
      ) pr ON true
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [userId, limit, offset],
    );

    return result.rows;
  }

  async getTicketsByUserId(
    userId: string,
    limit: number,
    offset: number,
    client: PoolClient,
  ): Promise<Ticket[]> {
    const result = await client.query<Ticket>(
      `
      SELECT
        id,
        order_id as "orderId",
        event_id as "eventId",
        user_id as "userId",
        ticket_number as "ticketNumber",
        status,
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM tickets
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [userId, limit, offset],
    );

    return result.rows;
  }

  async getTicketByCode(code: string, client: PoolClient): Promise<Ticket | null> {
    const result = await client.query<Ticket>(
      `
      SELECT
        id,
        order_id as "orderId",
        event_id as "eventId",
        user_id as "userId",
        ticket_number as "ticketNumber",
        status,
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM tickets
      WHERE ticket_number = $1
      `,
      [code],
    );

    return result.rows[0] || null;
  }

  async processPaymentWebhook(
    input: PaymentWebhookInput,
    idempotencyKey: string,
    client: PoolClient,
  ): Promise<CheckoutResult & { paymentStatus: string; duplicate: boolean }> {
    const order = await this.getOrderByIdForUpdate(input.orderId, client);

    if (!order) {
      throw new NotFoundError('Order', input.orderId);
    }

    const transition: PaymentTransition =
      input.status === 'settled' ? { kind: 'settle' } : { kind: 'fail' };
    const outcome = await this.applyTransition(order, transition, input, idempotencyKey, client);

    return this.mapOutcomeToResponse(outcome);
  }

  private async applyTransition(
    order: Order,
    transition: PaymentTransition,
    input: PaymentWebhookInput,
    idempotencyKey: string,
    client: PoolClient,
  ): Promise<WebhookOutcome> {
    if (transition.kind === 'settle') {
      return this.handleSettle(order, input, idempotencyKey, client);
    }

    return this.handleFail(order, input, idempotencyKey, client);
  }

  private async handleSettle(
    order: Order,
    input: PaymentWebhookInput,
    idempotencyKey: string,
    client: PoolClient,
  ): Promise<WebhookOutcome> {
    if (order.status === 'paid') {
      const tickets = await this.getTicketsByOrderId(order.id, client);
      return { kind: 'idempotent_settled', order, tickets };
    }

    if (order.status === 'cancelled') {
      throw new ConflictError('Cancelled order cannot be settled');
    }

    await this.insertPaymentRecord(
      order.id,
      'settled',
      input.providerTransactionId,
      idempotencyKey,
      client,
    );

    const paidOrder = await this.markOrderAsPaid(order.id, client);
    const existingTickets = await this.getTicketsByOrderId(order.id, client);
    const tickets = existingTickets.length > 0
      ? existingTickets
      : await this.issueTicketsForOrder(paidOrder, client);

    return { kind: 'newly_settled', order: paidOrder, tickets };
  }

  private async handleFail(
    order: Order,
    input: PaymentWebhookInput,
    idempotencyKey: string,
    client: PoolClient,
  ): Promise<WebhookOutcome> {
    if (order.status === 'paid') {
      // fail webhook이 도착했지만 order는 이미 paid 상태.
      // 정상 흐름이 아니다 (provider가 settled 통지 후 다시 fail을 보낸 경우).
      // 이미 settled 상태가 답이므로 그 결과를 반환하지만, kind를 별도로 두어
      // audit log에서 settle/fail 의도가 다른 케이스를 구분 가능하게 한다.
      this.logger.warn(
        {
          orderId: order.id,
          providerTransactionId: input.providerTransactionId,
          idempotencyKey,
        },
        'Late failure webhook arrived for already-paid order; existing settled state preserved',
      );
      const tickets = await this.getTicketsByOrderId(order.id, client);
      return { kind: 'late_failure_after_settled', order, tickets };
    }

    if (order.status === 'cancelled') {
      return { kind: 'idempotent_failed', order };
    }

    await this.insertPaymentRecord(
      order.id,
      'failed',
      input.providerTransactionId,
      idempotencyKey,
      client,
    );
    await this.inventory.adjustAvailableSeats(order.eventId, order.quantity, client);
    const cancelledOrder = await this.cancelOrder(order.id, client);

    return { kind: 'newly_failed', order: cancelledOrder };
  }

  private mapOutcomeToResponse(
    outcome: WebhookOutcome,
  ): CheckoutResult & { paymentStatus: string; duplicate: boolean } {
    switch (outcome.kind) {
      case 'idempotent_settled':
        return {
          order: outcome.order,
          tickets: outcome.tickets,
          paymentStatus: 'settled',
          duplicate: true,
        };
      case 'newly_settled':
        return {
          order: outcome.order,
          tickets: outcome.tickets,
          paymentStatus: 'settled',
          duplicate: false,
        };
      case 'idempotent_failed':
        return {
          order: outcome.order,
          tickets: [],
          paymentStatus: 'failed',
          duplicate: true,
        };
      case 'newly_failed':
        return {
          order: outcome.order,
          tickets: [],
          paymentStatus: 'failed',
          duplicate: false,
        };
      case 'late_failure_after_settled':
        // 응답 자체는 idempotent_settled와 동일.
        // 호출자(라우트, 클라이언트)가 보는 응답 shape에 차이를 두지 않는 이유는
        // "최종 상태는 settled"라는 외부 사실이 같기 때문이다.
        // 내부 audit/모니터링은 outcome.kind 자체로 구분한다 (handleFail의 warn 로그).
        return {
          order: outcome.order,
          tickets: outcome.tickets,
          paymentStatus: 'settled',
          duplicate: true,
        };
    }
  }

  private async issueTicketsForOrder(order: Order, client: PoolClient): Promise<Ticket[]> {
    const existingTickets = await this.getTicketsByOrderId(order.id, client);
    if (existingTickets.length > 0) {
      return existingTickets;
    }

    const tickets: Ticket[] = [];
    for (let index = 0; index < order.quantity; index++) {
      const ticketId = uuid();
      const sequenceResult = await client.query<{ sequence: string }>(
        `SELECT nextval('ticket_number_seq')::text as sequence`,
      );
      const ticketSequence = Number(sequenceResult.rows[0].sequence);
      const ticketNumber = generateTicketNumber(ticketSequence);

      const ticketResult = await client.query<Ticket>(
        `
        INSERT INTO tickets (id, order_id, event_id, user_id, ticket_number, status)
        VALUES ($1, $2, $3, $4, $5, 'active')
        RETURNING
          id, order_id as "orderId", event_id as "eventId", user_id as "userId",
          ticket_number as "ticketNumber",
          status, created_at as "createdAt", updated_at as "updatedAt"
        `,
        [ticketId, order.id, order.eventId, order.userId, ticketNumber],
      );

      tickets.push(ticketResult.rows[0]);
    }

    this.logger.info({ orderId: order.id, ticketCount: tickets.length }, 'Tickets issued after settlement');
    return tickets;
  }

  private async insertPaymentRecord(
    orderId: string,
    status: string,
    providerTransactionId: string,
    idempotencyKey: string,
    client: PoolClient,
  ): Promise<{ inserted: boolean; conflictingOrderId: string | null }> {
    const result = await client.query<{
      id: string;
      orderId: string;
      inserted: boolean;
    }>(
      `
      WITH attempted AS (
        INSERT INTO payment_records (
          id, order_id, status, provider_transaction_id, idempotency_key, webhook_received_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (provider_transaction_id) WHERE provider_transaction_id IS NOT NULL DO NOTHING
        RETURNING id, order_id as "orderId"
      )
      SELECT a.id, a."orderId", true as inserted
      FROM attempted a
      UNION ALL
      SELECT pr.id, pr.order_id as "orderId", false as inserted
      FROM payment_records pr
      WHERE pr.provider_transaction_id = $4
        AND NOT EXISTS (SELECT 1 FROM attempted)
      `,
      [uuid(), orderId, status, providerTransactionId, idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('insertPaymentRecord: no row returned');
    }

    if (row.inserted || row.orderId === orderId) {
      if (!row.inserted) {
        this.logger.warn(
          { orderId, providerTransactionId },
          'Duplicate payment record (same order) ignored',
        );
      }

      return { inserted: row.inserted, conflictingOrderId: null };
    }

    this.logger.error(
      {
        orderId,
        conflictingOrderId: row.orderId,
        providerTransactionId,
      },
      'providerTransactionId reused across different orders',
    );
    throw new ConflictError('providerTransactionId already used for a different order');
  }
}