import { FastifyInstance } from 'fastify';
import { getPostgresPool } from '@/infra/postgres/client';
import { EventService } from '@/core/services/event.service';
import { CreateEventSchema, GetEventsSchema } from '@/core/models/event';
import { ValidationError } from '@/core/errors';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';

export async function registerEventRoutes(app: FastifyInstance) {
  const logger = getLogger();
  const eventService = new EventService();
  const pool = getPostgresPool();

  app.post<{ Body: unknown }>('/events', async (request, reply) => {
    const config = getConfig();

    // POST /events는 운영자 전용 엔드포인트다.
    //
    // 정책:
    //   - ENABLE_ADMIN_EVENT_WRITE=false (default): 무조건 403
    //     (티켓팅 서비스에서 일반 사용자가 이벤트를 생성할 수 없어야 함)
    //   - ENABLE_ADMIN_EVENT_WRITE=true + ENFORCE_AUTH_USER_MATCH=true:
    //     JWT의 role 클레임이 'admin'일 때만 통과
    //   - ENABLE_ADMIN_EVENT_WRITE=true + ENFORCE_AUTH_USER_MATCH=false (demo):
    //     flag만으로 통과 (k6/seed 등 demo 흐름용)
    //
    // 별도 admin 도메인이 본 프로젝트의 학습 스코프 밖이므로 단순한 flag+role 조합만 둔다.
    if (!config.ENABLE_ADMIN_EVENT_WRITE) {
      return reply.code(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'Event creation is disabled (ENABLE_ADMIN_EVENT_WRITE=false)',
        },
      });
    }
    if (config.ENFORCE_AUTH_USER_MATCH && request.user?.role !== 'admin') {
      logger.warn(
        { userId: request.user?.id, role: request.user?.role, requestId: request.id },
        'Non-admin attempt to create event rejected',
      );
      return reply.code(403).send({
        error: { code: 'FORBIDDEN', message: 'Admin role required' },
      });
    }

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

  app.get<{ Querystring: unknown }>('/events', async (request, reply) => {
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