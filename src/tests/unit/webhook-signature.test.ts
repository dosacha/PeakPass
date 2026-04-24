import crypto from 'crypto';
import {
  computeWebhookSignature,
  verifyWebhookSignature,
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
});

describe('verifyWebhookSignature', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"event":"payment.settled","id":"evt_1"}', 'utf8');
  const validSignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  it('returns true for a valid signature', () => {
    expect(verifyWebhookSignature(secret, body, validSignature)).toBe(true);
  });

  it('returns false for a tampered signature', () => {
    const tampered = validSignature.replace(/.$/, (char) => (char === '0' ? '1' : '0'));

    expect(verifyWebhookSignature(secret, body, tampered)).toBe(false);
  });

  it('returns false for signatures with a different length', () => {
    expect(verifyWebhookSignature(secret, body, 'tooshort')).toBe(false);
    expect(verifyWebhookSignature(secret, body, `${validSignature}extra`)).toBe(false);
  });

  it('returns false when the secret differs', () => {
    expect(verifyWebhookSignature('different-secret', body, validSignature)).toBe(false);
  });

  it('returns false when the body bytes differ', () => {
    const modifiedBody = Buffer.from('{"event":"payment.settled","id":"evt_2"}', 'utf8');

    expect(verifyWebhookSignature(secret, modifiedBody, validSignature)).toBe(false);
  });
});
