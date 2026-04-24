import crypto from 'crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';

function getWebhookSignature(request: FastifyRequest): string | undefined {
  const header = request.headers['x-webhook-signature'];
  const value = Array.isArray(header) ? header[0] : header;
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export function computeWebhookSignature(secret: string, rawBody: Buffer): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  providedHex: string,
): boolean {
  const expectedHex = computeWebhookSignature(secret, rawBody);
  const providedBuffer = Buffer.from(providedHex, 'utf8');
  const expectedBuffer = Buffer.from(expectedHex, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
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

  const rawBody = request.rawBody;
  if (!rawBody) {
    logger.error(
      { url: request.url },
      'Webhook raw body not available for signature verification',
    );
    return reply.code(500).send({
      error: {
        code: 'RAW_BODY_UNAVAILABLE',
        message: 'unable to verify webhook signature',
      },
    });
  }

  if (!verifyWebhookSignature(secret, rawBody, signature)) {
    logger.warn({ url: request.url }, 'Webhook signature mismatch');
    return reply.code(401).send({
      error: {
        code: 'INVALID_SIGNATURE',
        message: 'webhook signature invalid',
      },
    });
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}
