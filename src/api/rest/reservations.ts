import { FastifyInstance } from 'fastify';
import { ReservationService } from '@/core/services/reservation.service';
import { CreateReservationSchema } from '@/core/models/reservation';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';
import { assertBodyUserMatchesAuth } from '@/api/middleware/auth';

/**
 * NOTE (known limitation):
 *   This route currently trusts `userId` from the request body.
 *   In a real deployment, the authenticated subject (JWT `sub`) should
 *   be cross-checked against `input.userId`. Tracked in README
 *   "Limitations". See also src/api/rest/checkouts.ts.
 */

export async function registerReservationRoutes(app: FastifyInstance) {
  const logger = getLogger();
  const reservationService = new ReservationService();

  app.post<{ Body: unknown }>('/reservations', async (request, reply) => {
    const input = CreateReservationSchema.parse(request.body);
    assertBodyUserMatchesAuth(request, input.userId);
    const reservation = await reservationService.createReservation(input);

    logger.info({ reservationId: reservation.id, eventId: input.eventId }, 'Reservation created');
    return reply.code(201).send(reservation);
  });

  app.get<{ Params: { id: string } }>('/reservations/:id', async (request, reply) => {
    const { id } = request.params;
    const config = getConfig();
    const reservation = await reservationService.getReservation(id);

    // Ownership 검증. checkouts와 동일 정책.
    // mismatch와 not-found 모두 404로 응답해 reservation 존재 여부가 누설되지 않게 한다.
    if (config.ENFORCE_AUTH_USER_MATCH) {
      if (!request.user?.id) {
        return reply.code(401).send({
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
        });
      }
      if (!reservation || reservation.userId !== request.user.id) {
        if (reservation) {
          logger.warn(
            {
              reservationId: id,
              requestedBy: request.user.id,
              ownerId: reservation.userId,
              requestId: request.id,
            },
            'Reservation ownership mismatch on GET /reservations/:id',
          );
        }
        return reply.code(404).send({ error: 'Reservation not found' });
      }
    } else if (!reservation) {
      return reply.code(404).send({ error: 'Reservation not found' });
    }

    return reply.send(reservation);
  });
}
