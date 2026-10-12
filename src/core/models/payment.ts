import { z } from 'zod';
import { uuid } from './uuid';

export const PaymentWebhookStatus = z.enum(['settled', 'failed']);
export type PaymentWebhookStatus = z.infer<typeof PaymentWebhookStatus>;

export const PaymentWebhookSchema = z.object({
  orderId: uuid,
  providerTransactionId: z.string().min(1).max(255),
  status: PaymentWebhookStatus,
});

export type PaymentWebhookInput = z.infer<typeof PaymentWebhookSchema>;
