import { z } from 'zod';

export const ReservationStatus = z.enum(['active', 'released', 'converted']);
export type ReservationStatus = z.infer<typeof ReservationStatus>;

export interface Reservation {
  id: string;
  userId: string;
  eventId: string;
  quantity: number;
  tierId: string;
  expiresAt: Date;
  status: ReservationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export const CreateReservationSchema = z.object({
  eventId: z.string().uuid(),
  userId: z.string().uuid(),
  quantity: z.number().int().positive().max(100), // 홀드당 최대 100좌석
  tierId: z.string(),
});

export type CreateReservationInput = z.infer<typeof CreateReservationSchema>;
