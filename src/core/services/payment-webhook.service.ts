import { PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';
import { Order } from '../models/order';
import { Ticket, generateTicketNumber } from '../models/ticket';
import { ConflictError, NotFoundError } from '../errors';
import { PaymentWebhookInput } from '../models/payment';
import { CheckoutResult } from './checkout.service';
import { InventoryService } from './inventory.service';
import { OrderService } from './order.service';
import { TicketService } from './ticket.service';
import { getLogger } from '@/infra/logger';

/**
 * Payment Provider settlement webhook 처리 서비스.
 *
 * 이 서비스의 책임:
 *   - 외부 결제 PG가 보낸 settlement webhook(`settled` 또는 `failed`)을 받아
 *     order 상태를 paid/cancelled로 전이
 *   - settled 시 ticket 발급 (paid 시점에서만)
 *   - duplicate webhook 멱등 처리 (이미 paid이면 기존 ticket 반환)
 *   - failed 시 좌석 원복 + payment_record 기록
 *   - provider_transaction_id 충돌 검사 (서로 다른 order에 같은 transaction id가
 *     달리는 경우 거부)
 *
 * 호출자는 트랜잭션 안에서 processPaymentWebhook을 호출해야 한다.
 * order 행을 FOR UPDATE로 잠그는 SELECT가 본 서비스 진입부에 있다.
 */

type PaymentTransition =
  | { kind: 'settle' }
  | { kind: 'fail' };

type WebhookOutcome =
  | { kind: 'expired'; order: Order; paymentStatus: string; duplicate: boolean }
  | { kind: 'idempotent_settled'; order: Order; tickets: Ticket[] }
  | { kind: 'idempotent_failed'; order: Order }
  | { kind: 'newly_settled'; order: Order; tickets: Ticket[] }
  | { kind: 'newly_failed'; order: Order }
  // fail webhook이 도착했지만 order는 이미 paid 상태인 경우.
  // 응답 자체는 settled 응답과 동일하지만 *입력 의도와 outcome이 다르다*는
  // 사실을 audit log/내부 분기에서 구분하기 위해 별도 kind로 분리한다.
  | { kind: 'late_failure_after_settled'; order: Order; tickets: Ticket[] };

export class PaymentWebhookService {
  private logger = getLogger();
  private inventory = new InventoryService();
  private orderService = new OrderService();
  private ticketService = new TicketService();

  async processPaymentWebhook(
    input: PaymentWebhookInput,
    idempotencyKey: string,
    client: PoolClient,
  ): Promise<CheckoutResult & { paymentStatus: string; duplicate: boolean }> {
    const order = await this.orderService.getOrderByIdForUpdate(input.orderId, client);

    if (!order) {
      throw new NotFoundError('Order', input.orderId);
    }

    await this.reserveCallbackKey(order.id, input.providerTransactionId, input.status, idempotencyKey, client);

    const transition: PaymentTransition =
      input.status === 'settled' ? { kind: 'settle' } : { kind: 'fail' };
    const outcome = await this.applyTransition(order, transition, input, idempotencyKey, client);

    return this.mapOutcomeToResponse(outcome);
  }

  private async reserveCallbackKey(orderId: string, providerTransactionId: string, status: PaymentWebhookInput['status'], idempotencyKey: string, client: PoolClient): Promise<void> {
    // Reserve every accepted callback, including early terminal replays and
    // failure-to-success corrections. Rejected transitions roll this back too.
    const inserted = await client.query(`INSERT INTO payment_callback_keys (idempotency_key, order_id, provider_transaction_id, callback_status)
      VALUES ($1, $2, $3, $4) ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key`,
    [idempotencyKey, orderId, providerTransactionId, status]);
    if (inserted.rowCount) return;
    const result = await client.query<{ order_id: string; provider_transaction_id: string; callback_status: string | null }>(
      `SELECT order_id, provider_transaction_id, callback_status FROM payment_callback_keys WHERE idempotency_key=$1`,
      [idempotencyKey],
    );
    const existing = result.rows[0];
    // NULL is an unverifiable legacy request, not permission to bind a new status on replay.
    if (!existing || existing.order_id !== orderId || existing.provider_transaction_id !== providerTransactionId || existing.callback_status !== status) {
      throw new ConflictError('Idempotency key already used for a different payment callback');
    }
  }

  private async applyTransition(
    order: Order,
    transition: PaymentTransition,
    input: PaymentWebhookInput,
    idempotencyKey: string,
    client: PoolClient,
  ): Promise<WebhookOutcome> {
    if (order.status === 'expired') {
      // Provider success is a durable financial fact, even when seats have already been returned.
      const record = await this.insertPaymentRecord(order.id, input.status,
        input.providerTransactionId, idempotencyKey, client, input.status === 'settled');
      return { kind: 'expired', order, paymentStatus: record.status, duplicate: !record.changed };
    }
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
      const tickets = await this.ticketService.getTicketsByOrderId(order.id, client);
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
    const existingTickets = await this.ticketService.getTicketsByOrderId(order.id, client);
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
      const tickets = await this.ticketService.getTicketsByOrderId(order.id, client);
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
      case 'expired':
        return { order: outcome.order, tickets: [], paymentStatus: outcome.paymentStatus, duplicate: outcome.duplicate };
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

  /**
   * order를 paid로 전이.
   * webhook 흐름에서만 호출되므로 본 서비스에 둔다.
   */
  private async markOrderAsPaid(orderId: string, client: PoolClient): Promise<Order> {
    const result = await client.query<Order>(
      `
      UPDATE orders
      SET status = 'paid', paid_at = NOW()
      WHERE id = $1
      RETURNING
        id, user_id as "userId", event_id as "eventId", quantity,
        tier_id as "tierId", unit_price as "unitPrice", total_amount as "totalAmount",
        status, idempotency_key as "idempotencyKey",
        payment_deadline_at as "paymentDeadlineAt",
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

  /**
   * order를 cancelled로 전이.
   * failed webhook 흐름에서만 호출되므로 본 서비스에 둔다.
   */
  private async cancelOrder(orderId: string, client: PoolClient): Promise<Order> {
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
        payment_deadline_at as "paymentDeadlineAt",
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

  /**
   * settlement 후 ticket 발급.
   *
   * - 동일 order에 대해 이미 발급된 ticket이 있으면 그대로 반환 (이중 발급 방지)
   * - ticket_number는 ticket_number_seq에서 받아 generateTicketNumber로 포맷
   * - 호출자가 트랜잭션 안에서 호출하므로 nextval과 INSERT가 같은 트랜잭션
   */
  private async issueTicketsForOrder(order: Order, client: PoolClient): Promise<Ticket[]> {
    const existingTickets = await this.ticketService.getTicketsByOrderId(order.id, client);
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

  /**
   * payment_records insert with provider_transaction_id 충돌 검사.
   *
   * 동작:
   * Same-provider duplicates retain their successful fact; late expired success upgrades failure
   * and marks reconciliation required. Cross-order provider identity reuse remains a conflict.
   * The conflict lookup is a separate statement so READ COMMITTED sees a concurrent insert.
   *
   * partial index의 WHERE provider_transaction_id IS NOT NULL은 "checkout 시점에
   * provider_transaction_id 없이 INSERT된 pending record"는 unique 제약에서 제외하기
   * 위해서다.
   */
  private async insertPaymentRecord(
    orderId: string,
    status: string,
    providerTransactionId: string,
    idempotencyKey: string,
    client: PoolClient,
    reconciliationRequired = false,
  ): Promise<{ changed: boolean; status: string }> {
    const result = await client.query<{
      id: string;
      orderId: string;
      status: string;
      reconciliationRequired: boolean;
    }>(
      `
        INSERT INTO payment_records (
          id, order_id, status, provider_transaction_id, idempotency_key, webhook_received_at, reconciliation_required
        )
        VALUES ($1, $2, $3, $4, $5, NOW(), $6)
        ON CONFLICT (provider_transaction_id) WHERE provider_transaction_id IS NOT NULL DO NOTHING
        RETURNING id, order_id as "orderId", status, reconciliation_required as "reconciliationRequired"
      `,
      [uuid(), orderId, status, providerTransactionId, idempotencyKey, reconciliationRequired],
    );
    if (result.rows[0]) return { changed: true, status: result.rows[0].status };
    const existing = await client.query<{ id: string; orderId: string; status: string; reconciliationRequired: boolean }>(
      `SELECT id, order_id as "orderId", status, reconciliation_required as "reconciliationRequired"
       FROM payment_records WHERE provider_transaction_id=$1`, [providerTransactionId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new Error('insertPaymentRecord: no row returned');
    }

    if (row.orderId === orderId) {
      if (reconciliationRequired && (row.status !== 'settled' || !row.reconciliationRequired)) {
        await client.query(`UPDATE payment_records SET status='settled', reconciliation_required=true,
          webhook_received_at=NOW() WHERE id=$1`, [row.id]);
        return { changed: true, status: 'settled' };
      }
      return { changed: false, status: row.status };
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
