import crypto from 'crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';

function getWebhookSignature(request: FastifyRequest): string | undefined {
  const header = request.headers['x-webhook-signature'];
  const value = Array.isArray(header) ? header[0] : header;
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function getBodyForSignature(request: FastifyRequest): string {
  return JSON.stringify(request.body ?? {});
}

export async function webhookSignatureMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!request.url.startsWith('/webhooks/')) {
    return;
  }

  const config = getConfig();
  const secret = config.WEBHOOK_SIGNING_SECRET;
  const logger = getLogger();

  if (!secret) {
    logger.warn(
      { url: request.url },
      'WEBHOOK_SIGNING_SECRET not configured, signature verification skipped',
    );
    return;
  }

  const signature = getWebhookSignature(request);
  if (!signature) {
    logger.warn({ url: request.url }, 'Webhook missing X-Webhook-Signature header');
    return reply.code(401).send({
      error: {
        code: 'MISSING_SIGNATURE',
        message: 'X-Webhook-Signature header required',
      },
    });
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(getBodyForSignature(request))
    .digest('hex');

  const provided = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const isValid =
    provided.length === expectedBuffer.length &&
    crypto.timingSafeEqual(provided, expectedBuffer);

  if (!isValid) {
    logger.warn({ url: request.url }, 'Webhook signature mismatch');
    return reply.code(401).send({
      error: {
        code: 'INVALID_SIGNATURE',
        message: 'webhook signature invalid',
      },
    });
  }
}
