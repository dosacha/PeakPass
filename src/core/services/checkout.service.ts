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

    if (input.reservationId) {
      const isValid = await this.reservationService.isReservationValidWithClient(
        input.reservationId,
        client,
      );
      if (!isValid) {
        throw new ConflictError('Reservation has expired or is no longer valid');
      }
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
      'Inventory deducted for checkout',
    );

    if (input.reservationId) {
      await this.reservationService.convertReservationWithClient(input.reservationId, client);
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
        this.logger.warn({ orderId, providerTransactionId, idempotencyKey }, 'Duplicate payment record ignored');
        return;
      }

      throw err;
    }
  }
}
