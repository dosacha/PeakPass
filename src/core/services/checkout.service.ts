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
  | { kind: 'newly_failed'; order: Order };

export class CheckoutService {
  private logger = getLogger();
  private reservationService = new ReservationService();
  private inventory = new InventoryService();

  async checkout(input: CreateOrderInput, client: PoolClient): Promise<CheckoutResult> {
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
    //   - affected = 0이면 invalid (released/expired/만료시간 초과).
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
      `,
      [input.eventId],
    );

    if (eventResult.rows.length === 0) {
      throw new NotFoundError('Event', input.eventId);
    }

    const event = eventResult.rows[0];

    // 좌석 검증은 reservation 없이 들어온 직접 checkout 경로에서만 한다.
    // reservation 경로는 reservation 단계에서 이미 좌석을 점유했다.
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
    const result = await client.query<
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
      const tickets = await this.getTicketsByOrderId(order.id, client);
      return { kind: 'idempotent_settled', order, tickets };
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
