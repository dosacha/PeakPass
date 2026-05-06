import { PoolClient } from 'pg';
import { Ticket } from '../models/ticket';

/**
 * Ticket 도메인의 read-only 조회 서비스.
 *
 * Ticket *발급*(issueTicketsForOrder)은 settlement webhook 흐름의 일부로
 * PaymentWebhookService 내부에 둔다. 본 서비스는 그 결과를 조회하는 책임만 진다.
 */
export class TicketService {
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

  /**
   * 티켓 번호로 단일 티켓 조회.
   * 게이트 검증(`/graphql ticketByCode`)에서 사용된다.
   */
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
}