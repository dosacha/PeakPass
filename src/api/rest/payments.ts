import { FastifyInstance } from 'fastify';
import { serializableTransaction } from '@/infra/postgres/client';
import { CheckoutService } from '@/core/services/checkout.service';
import { PaymentWebhookSchema } from '@/core/models/payment';
import { getLogger } from '@/infra/logger';
import { invalidateEventCache } from '@/infra/redis/commands';
import { storeIdempotencyResult } from '@/api/middleware/idempotency';

export async function registerPaymentRoutes(app: FastifyInstance) {
  const logger = getLogger();

  app.post<{ Body: unknown }>('/webhooks/payments/settlement', async (request, reply) => {
    const input = PaymentWebhookSchema.parse(request.body);
    const idempotencyKey = request.idempotencyKey;

    if (!idempotencyKey) {
      return reply.code(400).send({
        error: {
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key 헤더 필수',
        },
      });
    }

    logger.info(
      {
        orderId: input.orderId,
        providerTransactionId: input.providerTransactionId,
        status: input.status,
        idempotencyKey,
      },
      'Payment settlement webhook received',
    );

    const result = await serializableTransaction(async (client) => {
      const checkoutService = new CheckoutService();
      return checkoutService.processPaymentWebhook(input, idempotencyKey, client);
    });

    await invalidateEventCache(result.order.eventId);
    storeIdempotencyResult(result, 200, idempotencyKey);

    logger.info(
      {
        orderId: result.order.id,
        paymentStatus: result.paymentStatus,
        duplicate: result.duplicate,
        ticketCount: result.tickets.length,
      },
      'Payment settlement webhook processed',
    );

    return reply.code(200).send(result);
  });
}
