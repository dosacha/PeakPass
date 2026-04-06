import { PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';
import { CreateEventInput, Event, EventStatus, PricingTier } from '../models/event';
import { getLogger } from '@/infra/logger';
import { getPostgresPool } from '@/infra/postgres/client';

type EventRow = {
  id: string;
  name: string;
  description?: string;
  startsAt: Date;
  endsAt: Date;
  totalSeats: number;
  availableSeats: number;
  pricing: PricingTier[];
  status: EventStatus;
  createdAt: Date;
  updatedAt: Date;
};

export class EventService {
  private logger = getLogger();

  async createEvent(input: CreateEventInput, client?: PoolClient): Promise<Event> {
    if (client) {
      return this.createEventWithClient(input, client);
    }

    const pool = getPostgresPool();
    const localClient = await pool.connect();

    try {
      await localClient.query('BEGIN');
      const event = await this.createEventWithClient(input, localClient);
      await localClient.query('COMMIT');
      return event;
    } catch (err) {
      await localClient.query('ROLLBACK');
      throw err;
    } finally {
      localClient.release();
    }
  }

  async createEventWithClient(input: CreateEventInput, client: PoolClient): Promise<Event> {
    const eventId = uuid();
    const pricingTiers: PricingTier[] = input.pricing.map((tier) => ({
      id: uuid(),
      name: tier.name,
      price: tier.price,
      quantity: tier.quantity,
      description: tier.description,
    }));

    const result = await client.query<EventRow>(
      `
      INSERT INTO events (id, name, description, starts_at, ends_at, total_seats, available_seats, pricing, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'published')
      RETURNING
        id, name, description, starts_at as "startsAt", ends_at as "endsAt",
        total_seats as "totalSeats", available_seats as "availableSeats",
        pricing::jsonb as "pricing", status, created_at as "createdAt", updated_at as "updatedAt"
      `,
      [
        eventId,
        input.name,
        input.description || null,
        input.startsAt,
        input.endsAt,
        input.totalSeats,
        input.totalSeats,
        JSON.stringify(pricingTiers),
      ],
    );

    const event = result.rows[0];
    this.logger.info({ eventId: event.id }, 'Event created');
    return event;
  }

  async getEvents(limit = 20, offset = 0, client?: PoolClient): Promise<Event[]> {
    if (client) {
      return this.getEventsWithClient(limit, offset, client);
    }

    const pool = getPostgresPool();
    const localClient = await pool.connect();

    try {
      return await this.getEventsWithClient(limit, offset, localClient);
    } finally {
      localClient.release();
    }
  }

  async getEventsWithClient(limit: number, offset: number, client: PoolClient): Promise<Event[]> {
    const result = await client.query<EventRow>(
      `
      SELECT
        id, name, description, starts_at as "startsAt", ends_at as "endsAt",
        total_seats as "totalSeats", available_seats as "availableSeats",
        pricing::jsonb as "pricing", status, created_at as "createdAt", updated_at as "updatedAt"
      FROM events
      WHERE status = 'published'
      ORDER BY starts_at DESC
      LIMIT $1 OFFSET $2
      `,
      [limit, offset],
    );

    return result.rows;
  }

  async getEventById(eventId: string, client?: PoolClient): Promise<Event | null> {
    if (client) {
      return this.getEventByIdWithClient(eventId, client);
    }

    const pool = getPostgresPool();
    const localClient = await pool.connect();

    try {
      return await this.getEventByIdWithClient(eventId, localClient);
    } finally {
      localClient.release();
    }
  }

  async getEventByIdWithClient(eventId: string, client: PoolClient): Promise<Event | null> {
    const result = await client.query<EventRow>(
      `
      SELECT
        id, name, description, starts_at as "startsAt", ends_at as "endsAt",
        total_seats as "totalSeats", available_seats as "availableSeats",
        pricing::jsonb as "pricing", status, created_at as "createdAt", updated_at as "updatedAt"
      FROM events
      WHERE id = $1
      `,
      [eventId],
    );

    return result.rows[0] || null;
  }

  async getAvailabilityWithClient(eventId: string, client: PoolClient): Promise<number | null> {
    const result = await client.query<{ available_seats: number }>(
      'SELECT available_seats FROM events WHERE id = $1',
      [eventId],
    );

    return result.rows[0]?.available_seats ?? null;
  }

  async getEventsByIds(eventIds: readonly string[]): Promise<(Event | null)[]> {
    const pool = getPostgresPool();
    const client = await pool.connect();

    try {
      return await this.getEventsByIdsWithClient([...eventIds], client);
    } finally {
      client.release();
    }
  }

  async getEventsByIdsWithClient(eventIds: string[], client: PoolClient): Promise<(Event | null)[]> {
    if (eventIds.length === 0) {
      return [];
    }

    const placeholders = eventIds.map((_, index) => `$${index + 1}`).join(',');
    const result = await client.query<EventRow>(
      `
      SELECT
        id, name, description, starts_at as "startsAt", ends_at as "endsAt",
        total_seats as "totalSeats", available_seats as "availableSeats",
        pricing::jsonb as "pricing", status, created_at as "createdAt", updated_at as "updatedAt"
      FROM events
      WHERE id IN (${placeholders})
      `,
      eventIds,
    );

    const eventsMap = new Map(result.rows.map((event) => [event.id, event]));
    return eventIds.map((id) => eventsMap.get(id) || null);
  }
}
