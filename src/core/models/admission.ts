import { z } from 'zod';
import { AppError } from '@/core/errors';

export const admissionProfile = Object.freeze({
  revision: 'admission-v1-seed',
  rate: 2,
  capacity: 8,
  ttlMs: 30000,
  claimMs: 15000,
  tickMs: 250,
  batch: 2,
  cleanup: 100,
  reclaim: 8,
  leaseMs: 120000,
  maxWaiting: 1000,
  maxEntries: 10000,
  epochMs: 86400000,
});
export interface AdmissionOutcome {
  kind: 'reservation' | 'direct-checkout' | 'rejected';
  resourceId: string | null;
  code: string | null;
}
export interface AdmissionSnapshot {
  admissionId: string;
  epoch: string;
  state: 'waiting' | 'admitted' | 'consumed' | 'cancelled' | 'expired';
  phase: 'idle' | 'processing' | 'reconciling';
  sequence: string;
  position: number | null;
  joinedAt: string;
  admittedAt: string | null;
  expiresAt: string | null;
  reason: string | null;
  outcome: AdmissionOutcome | null;
}
export interface AdmissionResponse {
  contractRevision: 'admission-v1';
  serverTime: string;
  queue: { eventId: string; epoch: string; mode: 'open' };
  admission: AdmissionSnapshot | null;
  nextPollAfterMs: number | null;
}
export interface ClaimIdentity {
  eventId: string;
  userId: string;
  admissionId: string;
  epoch: string;
  fingerprint: string;
}
export interface AdmissionClaim extends ClaimIdentity {
  claimToken: string;
  deadline: number;
}
export class AdmissionError extends AppError {
  constructor(
    code: string,
    status: number,
    public nextPollAfterMs: number | null = null,
    public admission?: AdmissionSnapshot,
  ) {
    super(code, status, code);
  }
}

/** The admission a purchase request submits: `{admissionId, admissionEpoch}` of contract §3. */
export interface AdmissionRef {
  admissionId: string;
  epoch: string;
}
const lowerUuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
const PurchaseAdmissionSchema = z.object({ admissionId: lowerUuid, admissionEpoch: lowerUuid });

/** Both fields or neither. One alone or a malformed value is 400 before any purchase work. */
export function parsePurchaseAdmission(body: unknown): AdmissionRef | undefined {
  const { admissionId, admissionEpoch } = (body ?? {}) as Record<string, unknown>;
  if (admissionId === undefined && admissionEpoch === undefined) return undefined;
  const parsed = PurchaseAdmissionSchema.safeParse({ admissionId, admissionEpoch });
  if (!parsed.success) throw new AdmissionError('ADMISSION_INVALID_INPUT', 400);
  return { admissionId: parsed.data.admissionId, epoch: parsed.data.admissionEpoch };
}
