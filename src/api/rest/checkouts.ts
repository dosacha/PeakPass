import { FastifyInstance } from 'fastify';
import { getPostgresPool, serializableTransaction } from '@/infra/postgres/client';
import { CheckoutService } from '@/core/services/checkout.service';
import { CreateOrderSchema } from '@/core/models/order';
import { getLogger } from '@/infra/logger';
import { deleteReservationHold, invalidateEventCache } from '@/infra/redis/commands';
import { storeIdempotencyResult } from '@/api/middleware/idempotency';

export async function registerCheckoutRoutes(app: FastifyInstance) {
  const logger = getLogger();
  const pool = getPostgresPool();

  app.post<{ Body: any }>('/checkouts', async (request, reply) => {
    const input = CreateOrderSchema.parse({
      ...(request.body as Record<string, unknown>),
      idempotencyKey:
        request.idempotencyKey ?? (request.body as { idempotencyKey?: string }).idempotencyKey,
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

    const orderResult = await serializableTransaction(async (client) => {
      const checkoutService = new CheckoutService();
      return checkoutService.checkout(input, client);
    });

    if (input.reservationId) {
      await deleteReservationHold(input.reservationId);
    }

    await invalidateEventCache(input.eventId);
    storeIdempotencyResult(orderResult, 201, request.idempotencyKey ?? input.idempotencyKey);

    logger.info(
      {
        orderId: orderResult.order.id,
        ticketCount: orderResult.tickets.length,
        idempotencyKey: request.idempotencyKey ?? input.idempotencyKey,
      },
      'Checkout completed successfully',
    );

    return reply.code(201).send(orderResult);
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
