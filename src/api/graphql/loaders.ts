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
  // 화폐는 직렬화 경계에서 string으로 흐른다 (정밀도 손실 방지).
  totalAmount: string;
  status: string;
  paymentStatus: string;
  createdAt: string;
  updatedAt: string;
};

export type GraphQLReservation = {
  id: string;
  userId: string;
  eventId: string;
  tierId: string;
  quantity: number;
  expiresAt: string;
  status: string;
};

export type GraphQLUserEventKey = {
  userId: string;
  eventId: string;
};

type OrderRow = {
  id: string;
  userId: string;
  eventId: string;
  quantity: number;
  totalAmount: string;
  status: string;
  paymentStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ReservationRow = {
  id: string;
  userId: string;
  eventId: string;
  tierId: string;
  quantity: number;
  expiresAt: Date;
  status: string;
};

type TicketCountRow = {
  userId: string;
  eventId: string;
  count: number;
};

export interface GraphQLContext {
  userId?: string;
  loaders: {
    eventLoader: DataLoader<string, Event | null>;
    userLoader: DataLoader<string, GraphQLUser>;
    orderLoader: DataLoader<string, GraphQLOrder>;
    activeReservationLoader: DataLoader<GraphQLUserEventKey, GraphQLReservation | null>;
    ticketCountLoader: DataLoader<GraphQLUserEventKey, number>;
  };
}

function userEventKey({ userId, eventId }: GraphQLUserEventKey): string {
  return `${userId}:${eventId}`;
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
          o.total_amount as "totalAmount",
          o.status,
          COALESCE(pr.status, 'pending') as "paymentStatus",
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
            totalAmount: order.totalAmount,
            status: order.status,
            paymentStatus: order.paymentStatus ?? 'pending',
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

  const activeReservationLoader = new DataLoader<
    GraphQLUserEventKey,
    GraphQLReservation | null,
    string
  >(
    async (keys: readonly GraphQLUserEventKey[]) => {
      logger.debug({ keys }, 'Loading active reservation batch');

      if (keys.length === 0) {
        return [];
      }

      const client = await pool.connect();

      try {
        const userIds = keys.map((key) => key.userId);
        const eventIds = keys.map((key) => key.eventId);
        const result = await client.query<ReservationRow>(
          `
          WITH requested AS (
            SELECT *
            FROM UNNEST($1::uuid[], $2::uuid[]) AS pair(user_id, event_id)
          )
          SELECT DISTINCT ON (r.user_id, r.event_id)
            r.id,
            r.user_id as "userId",
            r.event_id as "eventId",
            r.tier_id as "tierId",
            r.quantity,
            r.expires_at as "expiresAt",
            r.status
          FROM reservations r
          JOIN requested req
            ON req.user_id = r.user_id
           AND req.event_id = r.event_id
          WHERE r.status = 'active'
            AND r.expires_at > NOW()
          ORDER BY r.user_id, r.event_id, r.created_at DESC
          `,
          [userIds, eventIds],
        );

        const reservationMap = new Map(
          result.rows.map((reservation) => [
            userEventKey(reservation),
            {
              id: reservation.id,
              userId: reservation.userId,
              eventId: reservation.eventId,
              tierId: reservation.tierId,
              quantity: reservation.quantity,
              expiresAt: reservation.expiresAt.toISOString(),
              status: reservation.status,
            },
          ]),
        );

        return keys.map((key) => reservationMap.get(userEventKey(key)) ?? null);
      } finally {
        client.release();
      }
    },
    { cacheKeyFn: userEventKey },
  );

  const ticketCountLoader = new DataLoader<GraphQLUserEventKey, number, string>(
    async (keys: readonly GraphQLUserEventKey[]) => {
      logger.debug({ keys }, 'Loading ticket count batch');

      if (keys.length === 0) {
        return [];
      }

      const client = await pool.connect();

      try {
        const userIds = keys.map((key) => key.userId);
        const eventIds = keys.map((key) => key.eventId);
        const result = await client.query<TicketCountRow>(
          `
          WITH requested AS (
            SELECT *
            FROM UNNEST($1::uuid[], $2::uuid[]) AS pair(user_id, event_id)
          )
          SELECT
            t.user_id as "userId",
            t.event_id as "eventId",
            COUNT(*)::int as "count"
          FROM tickets t
          JOIN requested req
            ON req.user_id = t.user_id
           AND req.event_id = t.event_id
          WHERE t.status <> 'cancelled'
          GROUP BY t.user_id, t.event_id
          `,
          [userIds, eventIds],
        );

        const ticketCountMap = new Map(
          result.rows.map((row) => [userEventKey(row), row.count]),
        );

        return keys.map((key) => ticketCountMap.get(userEventKey(key)) ?? 0);
      } finally {
        client.release();
      }
    },
    { cacheKeyFn: userEventKey },
  );

  return {
    userId,
    loaders: {
      eventLoader,
      userLoader,
      orderLoader,
      activeReservationLoader,
      ticketCountLoader,
    },
  };
}

export function clearGraphQLContext(context: GraphQLContext) {
  context.loaders.eventLoader.clearAll();
  context.loaders.userLoader.clearAll();
  context.loaders.orderLoader.clearAll();
  context.loaders.activeReservationLoader.clearAll();
  context.loaders.ticketCountLoader.clearAll();
}
