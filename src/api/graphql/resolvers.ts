import { GraphQLError } from 'graphql';
import { GraphQLContext } from './loaders';
import { EventService } from '@/core/services/event.service';
import { CheckoutService } from '@/core/services/checkout.service';
import { getLogger } from '@/infra/logger';
import { AppError } from '@/core/errors';
import { getPostgresPool } from '@/infra/postgres/client';

const logger = getLogger();
const eventService = new EventService();
const checkoutService = new CheckoutService();

type GraphQLEventParent = {
  id: string;
  name: string;
  description?: string | null;
  startsAt: string | Date;
  totalSeats: number;
  availableSeats: number;
  pricing: Array<{
    id?: string;
    name: string;
    price: number;
    quantity: number;
    description?: string | null;
  }>;
  createdAt: string | Date;
  updatedAt: string | Date;
};

type GraphQLOrderParent = {
  id: string;
  userId: string;
  eventId: string;
  quantity: number;
  totalPrice: number;
  status: string;
  paymentStatus: string;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
};

type GraphQLTicketParent = {
  id: string;
  orderId: string;
  eventId: string;
  userId: string;
  ticketNumber: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}

function toGraphQLError(err: Error): GraphQLError {
  if (err instanceof AppError) {
    return new GraphQLError(err.message, {
      extensions: {
        code: err.code,
        statusCode: err.statusCode,
        ...(err.context && { context: err.context }),
      },
    });
  }

  return new GraphQLError('Internal server error', {
    extensions: {
      code: 'INTERNAL_ERROR',
      statusCode: 500,
    },
  });
}

export const resolvers = {
  Query: {
    events: async (
      _: unknown,
      { limit = 20, offset = 0 }: { limit?: number; offset?: number },
      _context: GraphQLContext,
    ) => {
      try {
        logger.info({ limit, offset }, 'Query: events');
        return await eventService.getEvents(limit, offset);
      } catch (err) {
        logger.error({ err, limit, offset }, 'Query failed: events');
        throw toGraphQLError(err as Error);
      }
    },

    event: async (_: unknown, { id }: { id: string }, context: GraphQLContext) => {
      try {
        logger.info({ id }, 'Query: event');
        return await context.loaders.eventLoader.load(id);
      } catch (err) {
        logger.error({ err, id }, 'Query failed: event');
        throw toGraphQLError(err as Error);
      }
    },

    myOrders: async (
      _: unknown,
      { limit = 10, offset = 0 }: { limit?: number; offset?: number },
      context: GraphQLContext,
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required', {
          extensions: { code: 'UNAUTHENTICATED', statusCode: 401 },
        });
      }

      const pool = getPostgresPool();
      const client = await pool.connect();

      try {
        logger.info({ userId: context.userId, limit, offset }, 'Query: myOrders');
        const orders = await checkoutService.getOrdersByUserId(context.userId, limit, offset, client);
        return orders.map((order) => ({
          id: order.id,
          userId: order.userId,
          eventId: order.eventId,
          quantity: order.quantity,
          totalPrice: Number(order.totalAmount),
          status: order.status,
          paymentStatus: order.paymentStatus,
          idempotencyKey: order.idempotencyKey,
          createdAt: toIsoString(order.createdAt),
          updatedAt: toIsoString(order.updatedAt),
        }));
      } catch (err) {
        logger.error({ err, userId: context.userId, limit, offset }, 'Query failed: myOrders');
        throw toGraphQLError(err as Error);
      } finally {
        client.release();
      }
    },

    myTickets: async (
      _: unknown,
      { limit = 20, offset = 0 }: { limit?: number; offset?: number },
      context: GraphQLContext,
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required', {
          extensions: { code: 'UNAUTHENTICATED', statusCode: 401 },
        });
      }

      const pool = getPostgresPool();
      const client = await pool.connect();

      try {
        logger.info({ userId: context.userId, limit, offset }, 'Query: myTickets');
        return await checkoutService.getTicketsByUserId(context.userId, limit, offset, client);
      } catch (err) {
        logger.error({ err, userId: context.userId, limit, offset }, 'Query failed: myTickets');
        throw toGraphQLError(err as Error);
      } finally {
        client.release();
      }
    },

    ticketByCode: async (
      _: unknown,
      { code }: { code: string },
      _context: GraphQLContext,
    ) => {
      const pool = getPostgresPool();
      const client = await pool.connect();

      try {
        logger.info({ code }, 'Query: ticketByCode');
        return await checkoutService.getTicketByCode(code, client);
      } catch (err) {
        logger.error({ err, code }, 'Query failed: ticketByCode');
        throw toGraphQLError(err as Error);
      } finally {
        client.release();
      }
    },
  },

  Event: {
    title: (parent: GraphQLEventParent) => parent.name,
    date: (parent: GraphQLEventParent) => toIsoString(parent.startsAt),
    capacity: (parent: GraphQLEventParent) => parent.totalSeats,
    pricing: (parent: GraphQLEventParent) =>
      parent.pricing.map((tier) => ({
        tier: tier.name,
        price: tier.price,
        seats: tier.quantity,
        available: tier.quantity,
      })),
    createdAt: (parent: GraphQLEventParent) => toIsoString(parent.createdAt),
    updatedAt: (parent: GraphQLEventParent) => toIsoString(parent.updatedAt),
  },

  Order: {
    event: async (parent: GraphQLOrderParent, _: unknown, context: GraphQLContext) => {
      return context.loaders.eventLoader.load(parent.eventId);
    },
    ticketCount: (parent: GraphQLOrderParent) => parent.quantity,
    totalPrice: (parent: GraphQLOrderParent) => parent.totalPrice,
  },

  Ticket: {
    order: async (parent: GraphQLTicketParent, _: unknown, context: GraphQLContext) => {
      return context.loaders.orderLoader.load(parent.orderId);
    },

    event: async (parent: GraphQLTicketParent, _: unknown, context: GraphQLContext) => {
      return context.loaders.eventLoader.load(parent.eventId);
    },

    user: async (parent: GraphQLTicketParent, _: unknown, context: GraphQLContext) => {
      return context.loaders.userLoader.load(parent.userId);
    },
    code: (parent: GraphQLTicketParent) => parent.ticketNumber,
    issuedAt: (parent: GraphQLTicketParent) => parent.createdAt,
    expiresAt: () => null,
  },
};
