import { PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';
import Decimal from 'decimal.js';
import { Order, CreateOrderInput } from '../models/order';
import { Ticket, generateTicketNumber } from '../models/ticket';
import { Event } from '../models/event';
import {
  InsufficientInventoryError,
  ValidationError,
  NotFoundError,
  ConflictError,
} from '../errors';
import { ReservationService } from './reservation.service';
import { getLogger } from '@/infra/logger';
import { PaymentWebhookInput } from '../models/payment';

export interface CheckoutResult {
  order: Order;
  tickets: Ticket[];
}

export class CheckoutService {
  private logger = getLogger();
  private reservationService = new ReservationService();

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
         WHERE id = $1 AND status = 'active' AND expires_at > NOW()
         RETURNING id`,
        [input.reservationId],
      );

      if (convertResult.rowCount === 0) {
        // Lazy expire: 만료된 reservation이 좌석을 점유하고 있으면 그 자리에서 정리한다.
        // expireReservationWithClient는 status가 'active'가 아니면 noop이므로
        // 이미 release/expire된 경우에도 안전하다.
        await this.reservationService.expireReservationWithClient(input.reservationId, client);
        throw new ConflictError('Reservation has expired or is no longer valid');
      }

      seatsAlreadyHeld = true;
    }

    const eventLock = await client.query<Event>(
      `
      SELECT
        id, total_seats as "totalSeats", available_seats as "availableSeats",
        pricing
      FROM events
      WHERE id = $1
      FOR UPDATE
      `,
      [input.eventId],
    );

    if (eventLock.rows.length === 0) {
      throw new NotFoundError('Event', input.eventId);
    }

    const event = eventLock.rows[0];

    // 좌석 검증은 reservation 없이 들어온 직접 checkout 경로에서만 한다.
    // reservation 경로는 reservation 단계에서 이미 좌석을 점유했다.
    if (!seatsAlreadyHeld) {
      if (event.availableSeats < input.quantity) {
        this.logger.warn(
          {
            eventId: input.eventId,
            available: event.availableSeats,
            requested: input.quantity,
          },
          'Insufficient inventory during checkout',
        );
        throw new InsufficientInventoryError(event.availableSeats, input.quantity);
      }
    }

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
      await client.query(
        `
        UPDATE events
        SET available_seats = available_seats - $1
        WHERE id = $2
        `,
        [input.quantity, input.eventId],
      );

      this.logger.info(
        {
          orderId,
          eventId: input.eventId,
          seatsDeducted: input.quantity,
          newAvailable: event.availableSeats - input.quantity,
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
        ticket_number as "ticketNumber", qr_code as "qrCode",
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
        qr_code as "qrCode",
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
        qr_code as "qrCode",
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

    const existingTickets = await this.getTicketsByOrderId(order.id, client);

    if (input.status === 'settled') {
      if (order.status === 'paid') {
        return {
          order,
          tickets: existingTickets,
          paymentStatus: 'settled',
          duplicate: true,
        };
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
      const issuedTickets = existingTickets.length > 0
        ? existingTickets
        : await this.issueTicketsForOrder(paidOrder, client);

      return {
        order: paidOrder,
        tickets: issuedTickets,
        paymentStatus: 'settled',
        duplicate: false,
      };
    }

    if (order.status === 'paid') {
      return {
        order,
        tickets: existingTickets,
        paymentStatus: 'settled',
        duplicate: true,
      };
    }

    if (order.status !== 'cancelled') {
      await this.insertPaymentRecord(
        order.id,
        'failed',
        input.providerTransactionId,
        idempotencyKey,
        client,
      );

      // 좌석 원복은 차감(`checkout`)과 같은 락 패턴을 사용한다.
      // SERIALIZABLE 격리만으로도 정합성은 유지되지만, 명시적 FOR UPDATE를 두면:
      //   1. 차감/원복 경로의 락 모델이 대칭이라 코드 의도가 분명함
      //   2. 격리수준이 낮아져도 (REPEATABLE READ 등) 동작이 안전함
      //   3. 동시 실패 webhook 다수 진입 시 SSI abort/retry 대신 lock-wait로 직렬화돼 비용이 적음
      await client.query(
        `SELECT id FROM events WHERE id = $1 FOR UPDATE`,
        [order.eventId],
      );

      await client.query(
        `
        UPDATE events
        SET available_seats = available_seats + $1
        WHERE id = $2
        `,
        [order.quantity, order.eventId],
      );

      const cancelledOrder = await this.cancelOrder(order.id, client);
      return {
        order: cancelledOrder,
        tickets: [],
        paymentStatus: 'failed',
        duplicate: false,
      };
    }

    return {
      order,
      tickets: [],
      paymentStatus: 'failed',
      duplicate: true,
    };
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
          ticket_number as "ticketNumber", qr_code as "qrCode",
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
  ): Promise<void> {
    try {
      await client.query(
        `
        INSERT INTO payment_records (
          id, order_id, status, provider_transaction_id, idempotency_key, webhook_received_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        `,
        [uuid(), orderId, status, providerTransactionId, idempotencyKey],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // UNIQUE violation. provider_transaction_id 또는 idempotency_key 충돌 가능성.
        // 단순히 "duplicate ignored"로 무시하면 *다른 orderId가 같은 providerTransactionId를*
        // 사용한 경우 (공격성 또는 데이터 오염) 그대로 통과되는 보안 결함이 된다.
        // 기존 record를 조회해 같은 order인지 검증하고, 다르면 ConflictError로 거부한다.
        const existing = await client.query<{
          order_id: string;
          provider_transaction_id: string;
          idempotency_key: string;
        }>(
          `SELECT order_id, provider_transaction_id, idempotency_key
           FROM payment_records
           WHERE provider_transaction_id = $1 OR idempotency_key = $2
           LIMIT 1`,
          [providerTransactionId, idempotencyKey],
        );

        if (existing.rowCount === 0) {
          // 충돌은 났지만 row 조회가 안 됨 (race condition). 안전을 위해 throw.
          throw err;
        }

        const row = existing.rows[0];
        if (row.order_id === orderId) {
          // 동일 order에 대한 재시도 — 정상적인 idempotent 동작.
          this.logger.warn(
            { orderId, providerTransactionId, idempotencyKey },
            'Duplicate payment record for same order ignored (idempotent)',
          );
          return;
        }

        // 다른 order에서 같은 providerTransactionId를 사용 — 데이터 오염 또는 공격 가능성.
        this.logger.error(
          {
            requestedOrderId: orderId,
            existingOrderId: row.order_id,
            providerTransactionId,
          },
          'payment_records UNIQUE conflict across orders (potential security event)',
        );
        throw new ConflictError(
          'provider_transaction_id already used by a different order',
        );
      }

      throw err;
    }
  }
}
