import { FastifyInstance } from 'fastify';
import { ReservationService } from '@/core/services/reservation.service';
import { CreateReservationSchema } from '@/core/models/reservation';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';
import { assertBodyUserMatchesAuth } from '@/api/middleware/auth';

/**
 * 정책 (현재 코드 기준):
 *   - POST /reservations: body.userId는 ENFORCE_AUTH_USER_MATCH=true (production default)
 *     일 때 JWT subject와 일치 검증. ENFORCE_AUTH_USER_MATCH=false (demo override)일
 *     때만 body userId를 그대로 신뢰하며 production에서는 fail-fast로 거부됨.
 *   - GET /reservations/:id: 본인 reservation만 조회. 미인증/소유자 mismatch는
 *     모두 404로 응답해 reservation 존재 여부가 누설되지 않도록 한다.
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

    // auth 가드를 DB 조회 *전에* 통과시킨다.
    // 무인증 요청이 어차피 401로 끊길 거라면 DB까지 갈 이유가 없다 (작은 DoS amplifier 제거).
    if (config.ENFORCE_AUTH_USER_MATCH && !request.user?.id) {
      return reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
      });
    }

    const reservation = await reservationService.getReservation(id);

    // Ownership 검증. checkouts와 동일 정책.
    // mismatch와 not-found 모두 404로 응답해 reservation 존재 여부가 누설되지 않게 한다.
    if (config.ENFORCE_AUTH_USER_MATCH) {
      // 위에서 request.user.id 존재가 보장됨
      if (!reservation || reservation.userId !== request.user!.id) {
        if (reservation) {
          logger.warn(
            {
              reservationId: id,
              requestedBy: request.user!.id,
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