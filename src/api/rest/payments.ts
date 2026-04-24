import { FastifyInstance } from 'fastify';
import { serializableTransactionWithRetry } from '@/infra/postgres/client';
import { CheckoutService } from '@/core/services/checkout.service';
import { PaymentWebhookSchema } from '@/core/models/payment';
import { getLogger } from '@/infra/logger';
import { invalidateEventCache, releaseIdempotencyLock } from '@/infra/redis/commands';
import { storeIdempotencyResult } from '@/api/middleware/idempotency';

export async function registerPaymentRoutes(app: FastifyInstance) {
  const logger = getLogger();

  app.post<{ Body: unknown }>('/webhooks/payments/settlement', async (request, reply) => {
    const idempotencyKey = request.idempotencyKey;

    try {
      const input = PaymentWebhookSchema.parse(request.body);

      if (!idempotencyKey) {
        return reply.code(400).send({
          error: {
            code: 'MISSING_IDEMPOTENCY_KEY',
            message: 'Idempotency-Key header is required',
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

      const result = await serializableTransactionWithRetry(async (client) => {
        const checkoutService = new CheckoutService();
        return checkoutService.processPaymentWebhook(input, idempotencyKey, client);
      });

      await invalidateEventCache(result.order.eventId);
      await storeIdempotencyResult(result, 200, idempotencyKey);

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
    } finally {
      if (request.idempotencyLockAcquired && idempotencyKey) {
        await releaseIdempotencyLock(idempotencyKey);
      }
    }
  });
}
