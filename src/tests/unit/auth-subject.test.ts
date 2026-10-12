import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { CreateOrderSchema } from '@/core/models/order';
import { CreateReservationSchema } from '@/core/models/reservation';
import { PaymentWebhookSchema } from '@/core/models/payment';
import { parsePurchaseAdmission } from '@/core/models/admission';

const ORIGINAL_ENV = process.env;
const JWT_SECRET = 'a'.repeat(32);
const LOWER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UPPER = LOWER.toUpperCase();

// A UUID compares without case in PostgreSQL but not in a string comparison or a Map lookup.
// Ids are therefore brought to the lower-case form PostgreSQL returns where they enter: the
// subject where the token is read, the ids of a request body in its schema. Ownership checks,
// replay comparisons and DataLoader keys then see one value per id.
describe('UUIDs that enter with a request', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test', JWT_SECRET };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
  });

  it('lower-cases the subject of a JWT when it is a UUID and leaves it alone when it is not', async () => {
    const { extractUserFromToken } = await import('@/api/middleware/auth');

    expect(extractUserFromToken(jwt.sign({ sub: UPPER }, JWT_SECRET))?.id).toBe(LOWER);
    expect(extractUserFromToken(jwt.sign({ sub: LOWER }, JWT_SECRET))?.id).toBe(LOWER);
    expect(extractUserFromToken(jwt.sign({ sub: 'Service-Account' }, JWT_SECRET))?.id).toBe(
      'Service-Account',
    );
    // PostgreSQL accepts this form, the schema does not: it stays as sent. It then fails the
    // string comparisons of the REST routes, while a query that only filters by it still finds
    // the user's rows.
    const unhyphenated = UPPER.replace(/-/g, '');
    expect(extractUserFromToken(jwt.sign({ sub: unhyphenated }, JWT_SECRET))?.id).toBe(
      unhyphenated,
    );
  });

  it('lower-cases the order id of a settlement and the admission fields of a purchase', () => {
    expect(
      PaymentWebhookSchema.parse({
        orderId: UPPER,
        providerTransactionId: 'txn-1',
        status: 'settled',
      }),
    ).toEqual({ orderId: LOWER, providerTransactionId: 'txn-1', status: 'settled' });
    expect(parsePurchaseAdmission({ admissionId: UPPER, admissionEpoch: UPPER })).toEqual({
      admissionId: LOWER,
      epoch: LOWER,
    });
  });

  it('lower-cases every UUID field of the two create requests', () => {
    expect(
      CreateOrderSchema.parse({
        eventId: UPPER,
        userId: UPPER,
        quantity: 1,
        tierId: 'General',
        idempotencyKey: UPPER,
        reservationId: UPPER,
      }),
    ).toEqual({
      eventId: LOWER,
      userId: LOWER,
      quantity: 1,
      tierId: 'General',
      idempotencyKey: LOWER,
      reservationId: LOWER,
    });
    expect(
      CreateReservationSchema.parse({ eventId: UPPER, userId: UPPER, quantity: 1, tierId: 'A' }),
    ).toEqual({ eventId: LOWER, userId: LOWER, quantity: 1, tierId: 'A' });
  });

  // The route parses the body first and hands the parsed userId to the check, as the purchase
  // routes do.
  async function probe(subject: string, bodyUserId: string) {
    const { jwtAuthMiddleware, assertBodyUserMatchesAuth } = await import('@/api/middleware/auth');
    const app = Fastify();
    app.addHook('preHandler', jwtAuthMiddleware);
    app.post('/probe', async (request) => {
      const input = CreateReservationSchema.pick({ userId: true }).parse(request.body);
      assertBodyUserMatchesAuth(request, input.userId);
      return { subject: request.user?.id, userId: input.userId };
    });
    try {
      return await app.inject({
        method: 'POST',
        url: '/probe',
        headers: { authorization: `Bearer ${jwt.sign({ sub: subject }, JWT_SECRET)}` },
        payload: { userId: bodyUserId },
      });
    } finally {
      await app.close();
    }
  }

  it.each([
    ['upper-case subject, lower-case body', UPPER, LOWER],
    ['upper-case subject, upper-case body', UPPER, UPPER],
    ['lower-case subject, upper-case body', LOWER, UPPER],
  ])('matches subject and body userId whatever the case (%s)', async (_name, subject, body) => {
    const response = await probe(subject, body);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ subject: LOWER, userId: LOWER });
  });

  it('still refuses a body that names another user', async () => {
    const response = await probe(UPPER, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

    expect(response.statusCode).toBe(403);
  });
});
