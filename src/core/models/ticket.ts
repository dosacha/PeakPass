import { z } from 'zod';

export const TicketStatus = z.enum(['active', 'used', 'cancelled']);
export type TicketStatus = z.infer<typeof TicketStatus>;

export interface Ticket {
  id: string;
  orderId: string;
  eventId: string;
  userId: string;
  ticketNumber: string;
  qrCode?: string;
  status: TicketStatus;
  createdAt: Date;
  updatedAt: Date;
}

export function generateTicketNumber(sequence: number): string {
  const year = new Date().getFullYear();
  return `PASS-${year}-${String(sequence).padStart(6, '0')}`;
}
