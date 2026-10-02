import { FastifyInstance } from 'fastify';
import { getPostgresPool } from '@/infra/postgres/client';
import { CheckoutService } from '@/core/services/checkout.service';
import { purchaseTransaction, settleAdmission } from '@/core/services/admission-consumption';
import { OrderService } from '@/core/services/order.service';
import { TicketService } from '@/core/services/ticket.service';
import { CreateOrderSchema } from '@/core/models/order';
import { ConflictError } from '@/core/errors';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';
import {
  deleteReservationHold,
  invalidateEventCache,
  releaseIdempotencyLock,
} from '@/infra/redis/commands';
import { assertBodyUserMatchesAuth, purchaseAdmission } from '@/api/middleware/auth';

/**
 * 정책 (현재 코드 기준):
 *   - POST /checkouts: body.userId는 ENFORCE_AUTH_USER_MATCH=true (production default)
 *     일 때 JWT subject와 일치 검증. ENFORCE_AUTH_USER_MATCH=false (demo override)일
 *     때만 body userId를 그대로 신뢰하며 production에서는 fail-fast로 거부됨.
 *     보호 이벤트에서 reservation 없는 신규 주문은 본문의 admissionId/admissionEpoch로
 *     입장 자격을 소비해야 한다. 기존 주문 replay와 기존 reservation 전환은 면제된다.
 *   - GET /checkouts/:orderId: 본인 order만 조회. 미인증/소유자 mismatch는
 *     모두 404로 응답해 order 존재 여부가 누설되지 않도록 한다.
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

      // admission 필드가 있으면 JWT 없는 요청은 admission 계약의 401 envelope로 먼저 끝난다.
      const admission = purchaseAdmission(request);
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

      const { settlement, ...orderResult } = await purchaseTransaction(
        async (client) => {
          const checkoutService = new CheckoutService();
          return checkoutService.checkout(input, client, admission);
        },
        { admission },
      );
      // The result is committed. Redis is told now; a failure here never changes the response.
      await settleAdmission(settlement);

      if (input.reservationId) {
        await deleteReservationHold(input.reservationId);
      }

      await invalidateEventCache(input.eventId);

      if ('rejected' in orderResult) {
        throw orderResult.rejected;
      }

      if ('reservationExpired' in orderResult) {
        throw new ConflictError('Reservation has expired or is no longer valid');
      }

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
      if (request.idempotencyLockToken && request.idempotencyKey && request.idempotencyScope) {
        await releaseIdempotencyLock(
          request.idempotencyScope,
          request.idempotencyKey,
          request.idempotencyLockToken,
        );
      }
    }
  });

  app.get<{ Params: { orderId: string } }>('/checkouts/:orderId', async (request, reply) => {
    const { orderId } = request.params;
    const config = getConfig();

    // auth 가드를 DB 조회 *전에* 통과시킨다.
    // 무인증 요청이 어차피 401로 끊길 거라면 DB connection을 잡을 이유가 없다.
    if (config.ENFORCE_AUTH_USER_MATCH && !request.user?.id) {
      return reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
      });
    }

    const client = await pool.connect();

    try {
      const order = await orderService.getOrderById(orderId, client);

      // Ownership 검증.
      //
      // ENFORCE_AUTH_USER_MATCH=true (production default):
      //   - order.userId != request.user.id → 404 (order 존재 자체를 숨겨 enumeration 방지)
      //
      // ENFORCE_AUTH_USER_MATCH=false (demo override):
      //   - body userId를 무인증 신뢰하는 demo 흐름과 짝. 조회 ownership도 검증하지 않음.
      //   - production fail-fast로 production에서는 이 분기가 절대 작동하지 않는다.
      //
      // order가 존재하지 않을 때와 ownership mismatch가 *같은 404 응답*인 것은 의도된 설계다.
      // 응답을 분기하면 order 존재 여부가 timing/응답 차이로 누설된다.
      if (config.ENFORCE_AUTH_USER_MATCH) {
        // 위에서 request.user.id 존재가 보장됨
        if (!order || order.userId !== request.user!.id) {
          if (order) {
            logger.warn(
              {
                orderId,
                requestedBy: request.user!.id,
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
