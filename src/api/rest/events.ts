import { FastifyInstance } from 'fastify';
import { getPostgresPool } from '@/infra/postgres/client';
import { EventService } from '@/core/services/event.service';
import { CreateEventSchema, GetEventsSchema } from '@/core/models/event';
import { ValidationError } from '@/core/errors';
import { getLogger } from '@/infra/logger';

export async function registerEventRoutes(app: FastifyInstance) {
  const logger = getLogger();
  const eventService = new EventService();
  const pool = getPostgresPool();

  app.post<{ Body: any }>('/events', async (request, reply) => {
    try {
      const input = CreateEventSchema.parse(request.body);
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        const event = await eventService.createEvent(input, client);
        await client.query('COMMIT');
        client.release();

        logger.info({ eventId: event.id }, 'Event created');
        return reply.code(201).send(event);
      } catch (err) {
        await client.query('ROLLBACK');
        client.release();
        throw err;
      }
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }

      throw err;
    }
  });

  app.get<{ Querystring: any }>('/events', async (request, reply) => {
    try {
      const input = GetEventsSchema.parse(request.query);
      const client = await pool.connect();

      try {
        const events = await eventService.getEvents(input.limit || 20, input.offset || 0, client);
        client.release();
        return reply.send(events);
      } catch (err) {
        client.release();
        throw err;
      }
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }

      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/events/:id', async (request, reply) => {
    const { id } = request.params;
    const client = await pool.connect();

    try {
      const event = await eventService.getEventById(id, client);

      if (!event) {
        return reply.code(404).send({ error: 'Event not found' });
      }

      return reply.send(event);
    } finally {
      client.release();
    }
  });
}
