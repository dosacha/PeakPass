import DataLoader from 'dataloader';
import { EventService } from '@/core/services/event.service';
import { getLogger } from '@/infra/logger';
import { getPostgresPool } from '@/infra/postgres/client';
import { Event } from '@/core/models/event';

const logger = getLogger();

export type GraphQLUser = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
};

export type GraphQLOrder = {
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

type OrderRow = {
  id: string;
  userId: string;
  eventId: string;
  quantity: number;
  totalPrice: string;
  status: string;
  paymentStatus: string | null;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
};

export interface GraphQLContext {
  userId?: string;
  loaders: {
    eventLoader: DataLoader<string, Event | null>;
    userLoader: DataLoader<string, GraphQLUser>;
    orderLoader: DataLoader<string, GraphQLOrder>;
  };
}

export function createGraphQLContext(userId?: string): GraphQLContext {
  const eventService = new EventService();
  const pool = getPostgresPool();

  const eventLoader = new DataLoader<string, Event | null>(async (eventIds: readonly string[]) => {
    logger.debug({ eventIds }, 'Loading event batch');
    const events = await eventService.getEventsByIds(eventIds);
    const eventMap = new Map(
      events
        .filter((event): event is NonNullable<typeof event> => event !== null)
        .map((event) => [event.id, event]),
    );

    return eventIds.map((eventId) => eventMap.get(eventId) ?? null);
  });

  const userLoader = new DataLoader<string, GraphQLUser>(async (userIds: readonly string[]) => {
    logger.debug({ userIds }, 'Loading user batch');

    const client = await pool.connect();

    try {
      const placeholders = userIds.map((_, index) => `$${index + 1}`).join(',');
      const result = await client.query<{
        id: string;
        email: string;
        name: string | null;
        createdAt: Date;
      }>(
        `
        SELECT id, email, name, created_at as "createdAt"
        FROM users
        WHERE id IN (${placeholders})
        `,
        [...userIds],
      );

      const userMap = new Map(
        result.rows.map((user) => [
          user.id,
          {
            id: user.id,
            email: user.email,
            name: user.name,
            createdAt: user.createdAt.toISOString(),
          },
        ]),
      );

      return userIds.map((id) => {
        const user = userMap.get(id);
        if (!user) {
          throw new Error(`User not found for GraphQL loader: ${id}`);
        }

        return user;
      });
    } finally {
      client.release();
    }
  });

  const orderLoader = new DataLoader<string, GraphQLOrder>(async (orderIds: readonly string[]) => {
    logger.debug({ orderIds }, 'Loading order batch');

    const client = await pool.connect();

    try {
      const placeholders = orderIds.map((_, index) => `$${index + 1}`).join(',');
      const result = await client.query<OrderRow>(
        `
        SELECT
          o.id,
          o.user_id as "userId",
          o.event_id as "eventId",
          o.quantity,
          o.total_amount as "totalPrice",
          o.status,
          COALESCE(pr.status, 'pending') as "paymentStatus",
          o.idempotency_key as "idempotencyKey",
          o.created_at as "createdAt",
          o.updated_at as "updatedAt"
        FROM orders o
        LEFT JOIN LATERAL (
          SELECT status
          FROM payment_records
          WHERE order_id = o.id
          ORDER BY created_at DESC
          LIMIT 1
        ) pr ON true
        WHERE o.id IN (${placeholders})
        `,
        [...orderIds],
      );

      const orderMap = new Map(
        result.rows.map((order) => [
          order.id,
          {
            id: order.id,
            userId: order.userId,
            eventId: order.eventId,
            quantity: order.quantity,
            totalPrice: Number(order.totalPrice),
            status: order.status,
            paymentStatus: order.paymentStatus ?? 'pending',
            idempotencyKey: order.idempotencyKey,
            createdAt: order.createdAt.toISOString(),
            updatedAt: order.updatedAt.toISOString(),
          },
        ]),
      );

      return orderIds.map((id) => {
        const order = orderMap.get(id);
        if (!order) {
          throw new Error(`Order not found for GraphQL loader: ${id}`);
        }

        return order;
      });
    } finally {
      client.release();
    }
  });

  return {
    userId,
    loaders: {
      eventLoader,
      userLoader,
      orderLoader,
    },
  };
}

export function clearGraphQLContext(context: GraphQLContext) {
  context.loaders.eventLoader.clearAll();
  context.loaders.userLoader.clearAll();
  context.loaders.orderLoader.clearAll();
}
