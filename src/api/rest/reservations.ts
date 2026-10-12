import { FastifyInstance } from 'fastify';
import { ReservationService } from '@/core/services/reservation.service';
import { CreateReservationSchema } from '@/core/models/reservation';
import { getConfig } from '@/infra/config';
import { getLogger } from '@/infra/logger';
import { assertBodyUserMatchesAuth, purchaseAdmission } from '@/api/middleware/auth';
import { z } from 'zod';
import { uuid } from '@/core/models/uuid';

const IdParamsSchema = z.object({ id: uuid });

/**
 * 정책 (현재 코드 기준):
 *   - POST /reservations: body.userId는 ENFORCE_AUTH_USER_MATCH=true (production default)
 *     일 때 JWT subject와 일치 검증. ENFORCE_AUTH_USER_MATCH=false (demo override)일
 *     때만 body userId를 그대로 신뢰하며 production에서는 fail-fast로 거부됨.
 *     보호 이벤트는 본문의 admissionId/admissionEpoch로 입장 자격을 소비해야 한다.
 *   - GET /reservations/:id: 본인 reservation만 조회. 미인증/소유자 mismatch는
 *     모두 404로 응답해 reservation 존재 여부가 누설되지 않도록 한다.
 */

export async function registerReservationRoutes(app: FastifyInstance) {
  const logger = getLogger();
  const reservationService = new ReservationService();

  app.post<{ Body: unknown }>(
    '/reservations',
    { config: { rateLimit: 'reservation' } },
    async (request, reply) => {
      const input = CreateReservationSchema.parse(request.body);
      // admission 필드가 있으면 JWT 없는 요청은 admission 계약의 401 envelope로 먼저 끝난다.
      const admission = purchaseAdmission(request);
      assertBodyUserMatchesAuth(request, input.userId);
      const reservation = await reservationService.createReservation(input, admission);

      logger.info({ reservationId: reservation.id, eventId: input.eventId }, 'Reservation created');
      return reply.code(201).send(reservation);
    },
  );

  // 조회도 예약 생성과 같은 한도를 쓴다. 입장 제어 계약(admission-v1 §2, §6)이 조회의 기존
  // limiter 정책 유지를 정하고 있어 바꾸지 않았다.
  app.get<{ Params: { id: string } }>(
    '/reservations/:id',
    { config: { rateLimit: 'reservation' } },
    async (request, reply) => {
      const config = getConfig();

      // auth 가드를 DB 조회 *전에* 통과시킨다.
      // 무인증 요청이 어차피 401로 끊길 거라면 DB까지 갈 이유가 없다 (작은 DoS amplifier 제거).
      if (config.ENFORCE_AUTH_USER_MATCH && !request.user?.id) {
        return reply.code(401).send({
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
        });
      }

      // UUID가 아닌 id는 DB까지 가면 22P02로 500이 된다. 입력 오류(400)로 끝낸다.
      // 인증 가드 뒤에 둔다: 인증 없는 요청은 id 형식과 무관하게 401이어야 한다.
      const { id } = IdParamsSchema.parse(request.params);

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
    },
  );
}
