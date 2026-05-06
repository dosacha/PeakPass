import { PoolClient } from 'pg';
import { Order } from '../models/order';

/**
 * Order 도메인의 read-only 조회 서비스.
 *
 * write 흐름(checkout, payment webhook)은 별도 서비스(CheckoutService,
 * PaymentWebhookService)에 두고, 본 서비스는 *조회*만 책임진다.
 *
 * 모든 메서드가 PoolClient를 인자로 받는 이유:
 *   - 호출자가 트랜잭션 경계를 결정한다 (read-modify-write 흐름의 read 부분 등)
 *   - REST/GraphQL 요청 단위로 connection 사용을 제어
 */
export class OrderService {
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

  /**
   * Webhook 처리 등 read-modify-write 흐름에서 사용.
   * 호출자는 반드시 트랜잭션 안에서 호출해야 한다 (FOR UPDATE는 트랜잭션 외부에서 의미 없음).
   */
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

  /**
   * 멱등성 키로 기존 주문 조회.
   *
   * checkout 흐름에서 advisory lock 획득 직후 호출되어, 동일 키 재시도를
   * 기존 주문 반환으로 처리한다 (idempotent 응답).
   */
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

  /**
   * 사용자별 주문 목록.
   * 각 주문의 paymentStatus는 LATERAL 서브쿼리로 가장 최근 payment_record 상태를 결합.
   * 결합 결과가 없으면 'pending'을 기본값으로 둔다.
   */
  async getOrdersByUserId(
    userId: string,
    limit: number,
    offset: number,
    client: PoolClient,
  ): Promise<Array<Order & { paymentStatus: string }>> {
    const result = await client.query<Order & { paymentStatus: string }>(
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
}