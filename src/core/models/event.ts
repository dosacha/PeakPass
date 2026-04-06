import { z } from 'zod';

export const EventStatus = z.enum(['draft', 'published', 'closed', 'cancelled']);
export type EventStatus = z.infer<typeof EventStatus>;

export interface Event {
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
}

export interface PricingTier {
  id: string;
  name: string;
  price: number;
  quantity: number;
  description?: string;
}

export const CreateEventSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  totalSeats: z.number().int().positive(),
  pricing: z.array(
    z.object({
      name: z.string(),
      price: z.number().positive(),
      quantity: z.number().int().positive(),
      description: z.string().optional(),
    }),
  ),
});

export type CreateEventInput = z.infer<typeof CreateEventSchema>;

export const GetEventsSchema = z.object({
  limit: z.coerce.number().int().positive().default(20).optional(),
  offset: z.coerce.number().int().nonnegative().default(0).optional(),
  status: EventStatus.optional(),
});

export type GetEventsInput = z.infer<typeof GetEventsSchema>;
