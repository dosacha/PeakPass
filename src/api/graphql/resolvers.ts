import { GraphQLError } from 'graphql';
import { GraphQLContext } from './loaders';
import { EventService } from '@/core/services/event.service';
import { OrderService } from '@/core/services/order.service';
import { TicketService } from '@/core/services/ticket.service';
import { getLogger } from '@/infra/logger';
import { AppError } from '@/core/errors';
import { getPostgresPool } from '@/infra/postgres/client';

const logger = getLogger();
const eventService = new EventService();
const orderService = new OrderService();
const ticketService = new TicketService();

const MAX_LIMIT_EVENTS = 100;
const MAX_LIMIT_ORDERS = 50;
const MAX_LIMIT_TICKETS = 100;

type GraphQLEventParent = {
  id: string;
  name: string;
  description?: string | null;
  startsAt: string | Date;
  endsAt: string | Date;
  totalSeats: number;
  availableSeats: number;
  pricing: Array<{
    id: string;
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
  // 화폐는 직렬화 경계에서 string으로 흐른다 (정밀도 손실 방지).
  totalAmount: string;
  status: string;
  paymentStatus: string;
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

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(1, Math.floor(value as number)), max);
}

function clampOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value as number));
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
      { limit, offset }: { limit?: number; offset?: number },
      _context: GraphQLContext,
    ) => {
      const safeLimit = clampLimit(limit, 10, MAX_LIMIT_EVENTS);
      const safeOffset = clampOffset(offset);

      try {
        logger.info({ limit: safeLimit, offset: safeOffset }, 'Query: events');
        return await eventService.getEvents(safeLimit, safeOffset);
      } catch (err) {
        logger.error({ err, limit: safeLimit, offset: safeOffset }, 'Query failed: events');
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
      { limit, offset }: { limit?: number; offset?: number },
      context: GraphQLContext,
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required', {
          extensions: { code: 'UNAUTHENTICATED', statusCode: 401 },
        });
      }

      const pool = getPostgresPool();
      const client = await pool.connect();
      const safeLimit = clampLimit(limit, 10, MAX_LIMIT_ORDERS);
      const safeOffset = clampOffset(offset);

      try {
        logger.info({ userId: context.userId, limit: safeLimit, offset: safeOffset }, 'Query: myOrders');
        const orders = await orderService.getOrdersByUserId(context.userId, safeLimit, safeOffset, client);
        return orders.map((order) => ({
          id: order.id,
          userId: order.userId,
          eventId: order.eventId,
          quantity: order.quantity,
          totalAmount: order.totalAmount,
          status: order.status,
          paymentStatus: order.paymentStatus,
          createdAt: toIsoString(order.createdAt),
          updatedAt: toIsoString(order.updatedAt),
        }));
      } catch (err) {
        logger.error({ err, userId: context.userId, limit: safeLimit, offset: safeOffset }, 'Query failed: myOrders');
        throw toGraphQLError(err as Error);
      } finally {
        client.release();
      }
    },

    myTickets: async (
      _: unknown,
      { limit, offset }: { limit?: number; offset?: number },
      context: GraphQLContext,
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required', {
          extensions: { code: 'UNAUTHENTICATED', statusCode: 401 },
        });
      }

      const pool = getPostgresPool();
      const client = await pool.connect();
      const safeLimit = clampLimit(limit, 20, MAX_LIMIT_TICKETS);
      const safeOffset = clampOffset(offset);

      try {
        logger.info({ userId: context.userId, limit: safeLimit, offset: safeOffset }, 'Query: myTickets');
        return await ticketService.getTicketsByUserId(context.userId, safeLimit, safeOffset, client);
      } catch (err) {
        logger.error({ err, userId: context.userId, limit: safeLimit, offset: safeOffset }, 'Query failed: myTickets');
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
        const ticket = await ticketService.getTicketByCode(code, client);
        if (!ticket) {
          return {
            valid: false,
            status: 'not_found',
            ticketNumber: code,
            eventName: null,
            startsAt: null,
            endsAt: null,
          };
        }

        const event = await eventService.getEventById(ticket.eventId, client);
        if (!event) {
          return {
            valid: false,
            status: 'event_not_found',
            ticketNumber: ticket.ticketNumber,
            eventName: null,
            startsAt: null,
            endsAt: null,
          };
        }

        return {
          valid: ticket.status === 'active',
          status: ticket.status,
          ticketNumber: ticket.ticketNumber,
          eventName: event.name,
          startsAt: toIsoString(event.startsAt),
          endsAt: toIsoString(event.endsAt),
        };
      } catch (err) {
        logger.error({ err, code }, 'Query failed: ticketByCode');
        throw toGraphQLError(err as Error);
      } finally {
        client.release();
      }
    },
  },

  Event: {
    startsAt: (parent: GraphQLEventParent) => toIsoString(parent.startsAt),
    pricing: (parent: GraphQLEventParent) =>
      parent.pricing.map((tier) => ({
        tierId: tier.id,
        name: tier.name,
        price: tier.price,
        seats: tier.quantity,
      })),
    myActiveReservation: async (
      parent: GraphQLEventParent,
      _: unknown,
      context: GraphQLContext,
    ) => {
      if (!context.userId) {
        return null;
      }

      return context.loaders.activeReservationLoader.load({
        userId: context.userId,
        eventId: parent.id,
      });
    },
    myTicketCount: async (
      parent: GraphQLEventParent,
      _: unknown,
      context: GraphQLContext,
    ) => {
      if (!context.userId) {
        return 0;
      }

      return context.loaders.ticketCountLoader.load({
        userId: context.userId,
        eventId: parent.id,
      });
    },
    createdAt: (parent: GraphQLEventParent) => toIsoString(parent.createdAt),
    updatedAt: (parent: GraphQLEventParent) => toIsoString(parent.updatedAt),
  },

  Order: {
    event: async (parent: GraphQLOrderParent, _: unknown, context: GraphQLContext) => {
      return context.loaders.eventLoader.load(parent.eventId);
    },
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
    issuedAt: (parent: GraphQLTicketParent) => parent.createdAt,
    expiresAt: async (parent: GraphQLTicketParent, _: unknown, context: GraphQLContext) => {
      const event = await context.loaders.eventLoader.load(parent.eventId);
      return event ? toIsoString(event.endsAt) : null;
    },
  },
};