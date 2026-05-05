import crypto from 'crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';

function getHeader(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers[name];
  const value = Array.isArray(header) ? header[0] : header;
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * 타임스탬프와 raw body를 묶어서 HMAC-SHA256으로 서명한다.
 *
 * Stripe-style 포맷:
 *   signed_payload = `${timestamp}.${rawBody}`
 *   signature = HMAC-SHA256(secret, signed_payload)
 *
 * 타임스탬프를 함께 서명하므로 공격자가 타임스탬프만 바꿔서
 * "오래되지 않은 것처럼 보이게 만드는" 위변조도 차단된다.
 */
export function computeWebhookSignature(
  secret: string,
  rawBody: Buffer,
  timestamp?: string,
): string {
  const hmac = crypto.createHmac('sha256', secret);
  if (timestamp) {
    hmac.update(`${timestamp}.`);
  }
  hmac.update(rawBody);
  return hmac.digest('hex');
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  providedHex: string,
  timestamp?: string,
): boolean {
  const expectedHex = computeWebhookSignature(secret, rawBody, timestamp);
  const providedBuffer = Buffer.from(providedHex, 'utf8');
  const expectedBuffer = Buffer.from(expectedHex, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * 타임스탬프 윈도우 검증.
 * - 형식: Unix epoch seconds (정수 문자열)
 * - 미래 timestamp도 차단 (clock skew 악용 방지)
 *
 * 반환:
 *   - 'ok': 윈도우 안
 *   - 'expired': 너무 오래됨 (replay 의심)
 *   - 'future': 너무 먼 미래 (clock skew 또는 변조 의심)
 *   - 'malformed': 정수 파싱 실패
 */
export function validateTimestamp(
  timestampHeader: string,
  toleranceSeconds: number,
  nowMs: number = Date.now(),
): 'ok' | 'expired' | 'future' | 'malformed' {
  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts) || ts <= 0) return 'malformed';

  const diffSeconds = nowMs / 1000 - ts;
  if (diffSeconds > toleranceSeconds) return 'expired';
  if (diffSeconds < -toleranceSeconds) return 'future';
  return 'ok';
}

export async function webhookSignatureMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!request.url.startsWith('/webhooks/')) return;

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

  const signature = getHeader(request, 'x-webhook-signature');
  const timestamp = getHeader(request, 'x-webhook-timestamp');

  if (!signature) {
    return reply.code(401).send({
      error: { code: 'MISSING_SIGNATURE', message: 'X-Webhook-Signature header required' },
    });
  }
  if (!timestamp) {
    return reply.code(401).send({
      error: { code: 'MISSING_TIMESTAMP', message: 'X-Webhook-Timestamp header required' },
    });
  }

  const tsCheck = validateTimestamp(timestamp, config.WEBHOOK_REPLAY_TOLERANCE_SECONDS);
  if (tsCheck !== 'ok') {
    logger.warn(
      { url: request.url, timestamp, reason: tsCheck },
      'Webhook timestamp rejected (replay window)',
    );
    return reply.code(401).send({
      error: { code: 'TIMESTAMP_OUT_OF_WINDOW', message: `webhook timestamp ${tsCheck}` },
    });
  }

  const rawBody = request.rawBody;
  if (!rawBody) {
    return reply.code(500).send({
      error: { code: 'RAW_BODY_UNAVAILABLE', message: 'unable to verify webhook signature' },
    });
  }

  if (!verifyWebhookSignature(secret, rawBody, signature, timestamp)) {
    return reply.code(401).send({
      error: { code: 'INVALID_SIGNATURE', message: 'webhook signature invalid' },
    });
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}