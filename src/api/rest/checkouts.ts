import { FastifyInstance } from 'fastify';
import { getPostgresPool, serializableTransactionWithRetry } from '@/infra/postgres/client';
import { CheckoutService } from '@/core/services/checkout.service';
import { OrderService } from '@/core/services/order.service';
import { TicketService } from '@/core/services/ticket.service';
import { CreateOrderSchema } from '@/core/models/order';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';
import {
  deleteReservationHold,
  invalidateEventCache,
  releaseIdempotencyLock,
} from '@/infra/redis/commands';
import { storeIdempotencyResult } from '@/api/middleware/idempotency';
import { assertBodyUserMatchesAuth } from '@/api/middleware/auth';

/**
 * NOTE (known limitation):
 *   This route currently trusts `userId` from the request body in demo override mode.
 *   In ENFORCE_AUTH_USER_MATCH=true (production default), the authenticated subject
 *   (JWT `sub`) is cross-checked against `input.userId`. See README "Limitations".
 */

export async function registerCheckoutRoutes(app: FastifyInstance) {
  const logger = getLogger();
  const pool = getPostgresPool();
  const orderService = new OrderService();
  const ticketService = new TicketService();

  app.post<{ Body: Record<string, unknown> | undefined }>('/checkouts', async (request, reply) => {
    const body = request.body ?? {};
    const bodyIdempotencyKey =
      typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
    const idempotencyKey = request.idempotencyKey ?? bodyIdempotencyKey;

    try {
      const input = CreateOrderSchema.parse({
        ...body,
        idempotencyKey,
      });

      assertBodyUserMatchesAuth(request, input.userId);

      logger.info(
        {
          eventId: input.eventId,
          userId: input.userId,
          quantity: input.quantity,
          idempotencyKey: input.idempotencyKey,
        },
        'Checkout request',
      );

      const orderResult = await serializableTransactionWithRetry(async (client) => {
        const checkoutService = new CheckoutService();
        return checkoutService.checkout(input, client);
      });

      if (input.reservationId) {
        await deleteReservationHold(input.reservationId);
      }

      await invalidateEventCache(input.eventId);
      await storeIdempotencyResult(orderResult, 201, idempotencyKey);

      logger.info(
        {
          orderId: orderResult.order.id,
          ticketCount: orderResult.tickets.length,
          idempotencyKey,
        },
        'Checkout completed successfully',
      );

      return reply.code(201).send(orderResult);
    } finally {
      if (request.idempotencyLockToken && request.idempotencyKey) {
        await releaseIdempotencyLock(request.idempotencyKey, request.idempotencyLockToken);
      }
    }
  });

  app.get<{ Params: { orderId: string } }>('/checkouts/:orderId', async (request, reply) => {
    const { orderId } = request.params;
    const config = getConfig();
    const client = await pool.connect();

    try {
      const order = await orderService.getOrderById(orderId, client);

      // Ownership 검증.
      //
      // ENFORCE_AUTH_USER_MATCH=true (production default):
      //   - 인증되지 않은 요청 → 401
      //   - order.userId != request.user.id → 404 (order 존재 자체를 숨겨 enumeration 방지)
      //
      // ENFORCE_AUTH_USER_MATCH=false (demo override):
      //   - body userId를 무인증 신뢰하는 demo 흐름과 짝. 조회 ownership도 검증하지 않음.
      //   - production fail-fast로 production에서는 이 분기가 절대 작동하지 않는다.
      //
      // order가 존재하지 않을 때와 ownership mismatch가 *같은 404 응답*인 것은 의도된 설계다.
      // 응답을 분기하면 order 존재 여부가 timing/응답 차이로 누설된다.
      if (config.ENFORCE_AUTH_USER_MATCH) {
        if (!request.user?.id) {
          return reply.code(401).send({
            error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
          });
        }
        if (!order || order.userId !== request.user.id) {
          if (order) {
            logger.warn(
              {
                orderId,
                requestedBy: request.user.id,
                ownerId: order.userId,
                requestId: request.id,
              },
              'Order ownership mismatch on GET /checkouts/:orderId',
            );
          }
          return reply.code(404).send({ error: 'Order not found' });
        }
      } else if (!order) {
        return reply.code(404).send({ error: 'Order not found' });
      }

      const tickets = await ticketService.getTicketsByOrderId(orderId, client);
      return reply.send({ order, tickets });
    } finally {
      client.release();
    }
  });
}