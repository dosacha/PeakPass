import crypto from 'crypto';
import Fastify from 'fastify';
import {
  computeWebhookSignature,
  verifyWebhookSignature,
  validateTimestamp,
  webhookSignatureMiddleware,
} from '@/api/middleware/webhook-signature';

describe('computeWebhookSignature', () => {
  it('returns the same hash for the same secret and body', () => {
    const secret = 'test-secret';
    const body = Buffer.from('{"event":"payment.settled","id":"evt_1"}', 'utf8');

    const first = computeWebhookSignature(secret, body);
    const second = computeWebhookSignature(secret, body);

    expect(first).toBe(second);
  });

  it('returns a 64-character SHA-256 hex digest', () => {
    const secret = 'test-secret';
    const body = Buffer.from('{}', 'utf8');

    const signature = computeWebhookSignature(secret, body);

    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the body differs only by whitespace', () => {
    const secret = 'test-secret';
    const compactBody = Buffer.from('{"x":1}', 'utf8');
    const spacedBody = Buffer.from('{"x": 1}', 'utf8');

    expect(computeWebhookSignature(secret, compactBody)).not.toBe(
      computeWebhookSignature(secret, spacedBody),
    );
  });

  it('changes when the timestamp differs (replay binding)', () => {
    const secret = 'test-secret';
    const body = Buffer.from('{"x":1}', 'utf8');

    const sigA = computeWebhookSignature(secret, body, '1700000000');
    const sigB = computeWebhookSignature(secret, body, '1700000001');

    expect(sigA).not.toBe(sigB);
  });

  it('legacy signature (no timestamp) differs from timestamped signature', () => {
    const secret = 'test-secret';
    const body = Buffer.from('{"x":1}', 'utf8');

    expect(computeWebhookSignature(secret, body)).not.toBe(
      computeWebhookSignature(secret, body, '1700000000'),
    );
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"event":"payment.settled","id":"evt_1"}', 'utf8');
  const timestamp = '1700000000';
  const validSignature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');

  it('returns true for a valid timestamped signature', () => {
    expect(verifyWebhookSignature(secret, body, validSignature, timestamp)).toBe(true);
  });

  it('returns false for a tampered signature', () => {
    const tampered = validSignature.replace(/.$/, (char) => (char === '0' ? '1' : '0'));

    expect(verifyWebhookSignature(secret, body, tampered, timestamp)).toBe(false);
  });

  it('returns false for signatures with a different length', () => {
    expect(verifyWebhookSignature(secret, body, 'tooshort', timestamp)).toBe(false);
    expect(verifyWebhookSignature(secret, body, `${validSignature}extra`, timestamp)).toBe(false);
  });

  it('returns false when the secret differs', () => {
    expect(verifyWebhookSignature('different-secret', body, validSignature, timestamp)).toBe(false);
  });

  it('returns false when the body bytes differ', () => {
    const modifiedBody = Buffer.from('{"event":"payment.settled","id":"evt_2"}', 'utf8');

    expect(verifyWebhookSignature(secret, modifiedBody, validSignature, timestamp)).toBe(false);
  });

  it('returns false when the timestamp is changed (signature was bound to original)', () => {
    expect(verifyWebhookSignature(secret, body, validSignature, '1700000999')).toBe(false);
  });

  it('returns false when timestamp is dropped on a timestamped signature', () => {
    expect(verifyWebhookSignature(secret, body, validSignature)).toBe(false);
  });
});

describe('validateTimestamp', () => {
  // 2026-01-01T00:00:00Z 기준 (ms)
  const nowMs = 1767225600 * 1000;
  const tolerance = 300; // 5분

  it('returns ok within window', () => {
    expect(validateTimestamp(String(1767225600 - 60), tolerance, nowMs)).toBe('ok');
    expect(validateTimestamp(String(1767225600 + 60), tolerance, nowMs)).toBe('ok');
    expect(validateTimestamp(String(1767225600), tolerance, nowMs)).toBe('ok');
  });

  it('returns expired when older than tolerance', () => {
    expect(validateTimestamp(String(1767225600 - 301), tolerance, nowMs)).toBe('expired');
    expect(validateTimestamp(String(1767225600 - 86400), tolerance, nowMs)).toBe('expired');
  });

  it('returns future when later than tolerance', () => {
    expect(validateTimestamp(String(1767225600 + 301), tolerance, nowMs)).toBe('future');
    expect(validateTimestamp(String(1767225600 + 86400), tolerance, nowMs)).toBe('future');
  });

  it('returns malformed for non-numeric or non-positive', () => {
    expect(validateTimestamp('abc', tolerance, nowMs)).toBe('malformed');
    expect(validateTimestamp('', tolerance, nowMs)).toBe('malformed');
    expect(validateTimestamp('0', tolerance, nowMs)).toBe('malformed');
    expect(validateTimestamp('-1', tolerance, nowMs)).toBe('malformed');
  });
});

describe('payment settlement webhook route', () => {
  it('continues to reject an unsigned settlement webhook with 401', async () => {
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      JWT_SECRET: 'w'.repeat(32),
      WEBHOOK_SIGNING_SECRET: 'test-webhook-signing-secret',
    };

    try {
      const { registerPaymentRoutes } = await import('@/api/rest/payments');
      const app = Fastify();
      app.addHook('preHandler', webhookSignatureMiddleware);
      await registerPaymentRoutes(app);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/webhooks/payments/settlement',
          payload: {},
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          error: { code: 'MISSING_SIGNATURE' },
        });
      } finally {
        await app.close();
      }
    } finally {
      process.env = originalEnv;
    }
  });
});
