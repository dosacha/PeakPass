import { FastifyInstance } from 'fastify';
import { ReservationService } from '@/core/services/reservation.service';
import { CreateReservationSchema } from '@/core/models/reservation';
import { getLogger } from '@/infra/logger';

export async function registerReservationRoutes(app: FastifyInstance) {
  const logger = getLogger();
  const reservationService = new ReservationService();

  app.post<{ Body: any }>('/reservations', async (request, reply) => {
    const input = CreateReservationSchema.parse(request.body);
    const reservation = await reservationService.createReservation(input);

    logger.info({ reservationId: reservation.id, eventId: input.eventId }, 'Reservation created');
    return reply.code(201).send(reservation);
  });

  app.get<{ Params: { id: string } }>('/reservations/:id', async (request, reply) => {
    const { id } = request.params;
    const reservation = await reservationService.getReservation(id);

    if (!reservation) {
      return reply.code(404).send({ error: 'Reservation not found' });
    }

    return reply.send(reservation);
  });
}
