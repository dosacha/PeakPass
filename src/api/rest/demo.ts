import { FastifyInstance, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import {
  DemoSessionConfigurationError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/core/errors';
import { getConfig, Config } from '@/infra/config';
import { getLogger } from '@/infra/logger';
import { getPostgresPool, serializableTransactionWithRetry } from '@/infra/postgres/client';
import { invalidateEventCache } from '@/infra/redis/commands';
import { PaymentWebhookService } from '@/core/services/payment-webhook.service';
import { OrderService } from '@/core/services/order.service';
import { CheckoutResult } from '@/core/services/checkout.service';
import { Order } from '@/core/models/order';
import { AuthUser } from '@/api/middleware/auth';

type DemoUser = {
  id: string;
  email: string;
};

type DemoSession = {
  userId: string;
  email: string;
  token: string;
  expiresAt: string;
};

const DemoSettlementSchema = z.object({
  orderId: z.string().uuid(),
}).strict();

export type DemoSettlementRequest = {
  orderId: string;
  userId: string;
  idempotencyKey: string;
};

export type DemoSettlementResult = CheckoutResult & {
  paymentStatus: string;
  duplicate: boolean;
};

export type DemoSessionDependencies = {
  findUserByEmail?: (email: string) => Promise<DemoUser | null>;
  processSettlement?: (request: DemoSettlementRequest) => Promise<DemoSettlementResult>;
};

export async function findDemoUserByEmail(email: string): Promise<DemoUser | null> {
  const pool = getPostgresPool();
  const result = await pool.query<DemoUser>(
    'SELECT id, email FROM users WHERE email = $1 LIMIT 1',
    [email],
  );

  return result.rows[0] ?? null;
}

export function createDemoSession(user: DemoUser, config: Config): DemoSession {
  const expiresAt = new Date(Date.now() + config.DEMO_SESSION_TTL_SECONDS * 1000).toISOString();
  const token = jwt.sign(
    { email: user.email, role: 'demo' },
    config.JWT_SECRET,
    {
      subject: user.id,
      expiresIn: config.DEMO_SESSION_TTL_SECONDS,
    },
  );

  return {
    userId: user.id,
    email: user.email,
    token,
    expiresAt,
  };
}

function getHeaderValue(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers[name];
  const value = Array.isArray(header) ? header[0] : header;
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function requireDemoSession(request: FastifyRequest): AuthUser {
  if (!request.user) {
    throw new UnauthorizedError('Authentication required');
  }

  if (request.user.role !== 'demo') {
    throw new ForbiddenError('Live demo session required');
  }

  return request.user;
}

function requireDemoIdempotencyKey(request: FastifyRequest): string {
  const idempotencyKey = getHeaderValue(request, 'idempotency-key');
  if (!idempotencyKey) {
    throw new ValidationError('Idempotency-Key header is required');
  }

  const result = z.string().uuid().safeParse(idempotencyKey);
  if (!result.success) {
    throw new ValidationError('Idempotency-Key header must be a UUID');
  }

  return result.data;
}

export function assertDemoOrderOwnership(
  order: Pick<Order, 'userId'> | null,
  demoUserId: string,
): void {
  if (!order || order.userId !== demoUserId) {
    // Return the same response for missing and non-owned orders to avoid order enumeration.
    throw new NotFoundError('Order');
  }
}

export function createDemoProviderTransactionId(orderId: string): string {
  return `demo-settlement:${orderId}`;
}

export async function processDemoSettlement(
  request: DemoSettlementRequest,
): Promise<DemoSettlementResult> {
  const result = await serializableTransactionWithRetry(async (client) => {
    const orderService = new OrderService();
    const order = await orderService.getOrderByIdForUpdate(request.orderId, client);
    assertDemoOrderOwnership(order, request.userId);

    const paymentWebhookService = new PaymentWebhookService();
    return paymentWebhookService.processPaymentWebhook(
      {
        orderId: request.orderId,
        providerTransactionId: createDemoProviderTransactionId(request.orderId),
        status: 'settled',
      },
      request.idempotencyKey,
      client,
    );
  });

  await invalidateEventCache(result.order.eventId);
  return result;
}

export async function registerDemoSessionRoutes(
  app: FastifyInstance,
  dependencies: DemoSessionDependencies = {},
) {
  const config = getConfig();
  if (!config.ENABLE_DEMO_SESSION) {
    return;
  }

  const logger = getLogger();
  const findUserByEmail = dependencies.findUserByEmail ?? findDemoUserByEmail;
  const processSettlement = dependencies.processSettlement ?? processDemoSettlement;

  app.post('/demo/session', async (request, reply) => {
    const user = await findUserByEmail(config.DEMO_USER_EMAIL);
    if (!user) {
      throw new DemoSessionConfigurationError();
    }

    const session = createDemoSession(user, config);
    logger.info(
      { requestId: request.id, userId: user.id },
      'Issued live demo session',
    );

    return reply.header('Cache-Control', 'no-store').send(session);
  });

  app.post<{ Body: unknown }>('/demo/settlement', async (request, reply) => {
    const demoUser = requireDemoSession(request);
    const body = DemoSettlementSchema.parse(request.body);
    const idempotencyKey = requireDemoIdempotencyKey(request);
    const result = await processSettlement({
      orderId: body.orderId,
      userId: demoUser.id,
      idempotencyKey,
    });

    logger.info(
      {
        requestId: request.id,
        orderId: result.order.id,
        duplicate: result.duplicate,
        ticketCount: result.tickets.length,
      },
      'Live demo settlement processed',
    );

    return reply.header('Cache-Control', 'no-store').send(result);
  });
}
