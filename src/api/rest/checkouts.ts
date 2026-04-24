import { FastifyInstance } from 'fastify';
import { getPostgresPool, serializableTransactionWithRetry } from '@/infra/postgres/client';
import { CheckoutService } from '@/core/services/checkout.service';
import { CreateOrderSchema } from '@/core/models/order';
import { getLogger } from '@/infra/logger';
import {
  deleteReservationHold,
  invalidateEventCache,
  releaseIdempotencyLock,
} from '@/infra/redis/commands';
import { storeIdempotencyResult } from '@/api/middleware/idempotency';

/**
 * NOTE (known limitation):
 *   This route currently trusts `userId` from the request body.
 *   In a real deployment, the authenticated subject (JWT `sub`) should
 *   be cross-checked against `input.userId`. Tracked in README
 *   "Limitations". See also src/api/rest/reservations.ts.
 */

export async function registerCheckoutRoutes(app: FastifyInstance) {
  const logger = getLogger();
  const pool = getPostgresPool();

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
      if (request.idempotencyLockAcquired && request.idempotencyKey) {
        await releaseIdempotencyLock(request.idempotencyKey);
      }
    }
  });

  app.get<{ Params: { orderId: string } }>('/checkouts/:orderId', async (request, reply) => {
    const { orderId } = request.params;
    const client = await pool.connect();

    try {
      const checkoutService = new CheckoutService();
      const order = await checkoutService.getOrderById(orderId, client);
      const tickets = order ? await checkoutService.getTicketsByOrderId(orderId, client) : [];

      if (!order) {
        return reply.code(404).send({ error: 'Order not found' });
      }

      return reply.send({ order, tickets });
    } finally {
      client.release();
    }
  });
}
