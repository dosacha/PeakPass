/**
 * admission-v1 §5: a slot is returned only for a durable reason. This compares the ledger rows of
 * one published epoch with the Redis entries of that epoch and returns what does not fit.
 *
 * An entry whose claim is still open (admitted and not idle) is not final yet: its row may be
 * committed and waiting for the finalization or the reclaimer. It is skipped.
 */
export interface LedgerRow {
  admissionId: string;
  outcome: 'consumed' | 'rejected' | 'closed';
  /** The reservation or order of a consumed result. */
  targetId: string | null;
  errorCode: string | null;
}
export interface RedisEntry {
  admissionId: string;
  state: string;
  phase: string;
  /** Set by the claim and kept afterwards: the entry was used for a purchase request. */
  fingerprint?: string | null;
  outcome?: { kind?: string; code?: string | null; resourceId?: string | null } | null;
}

export function ledgerMismatches(rows: LedgerRow[], entries: RedisEntry[]): string[] {
  const problems: string[] = [];
  const entryOf = new Map(entries.map((entry) => [entry.admissionId, entry]));
  const rowOf = new Map(rows.map((row) => [row.admissionId, row]));
  const open = (entry: RedisEntry) => entry.state === 'admitted' && entry.phase !== 'idle';

  for (const row of rows) {
    const entry = entryOf.get(row.admissionId);
    if (!entry) {
      problems.push(`ledger row ${row.admissionId} (${row.outcome}) has no Redis entry`);
      continue;
    }
    if (open(entry)) continue;
    const fits =
      row.outcome === 'closed'
        ? entry.state === 'expired'
        : entry.state === 'consumed' &&
          (row.outcome === 'rejected'
            ? entry.outcome?.kind === 'rejected' && entry.outcome.code === row.errorCode
            : entry.outcome?.kind !== 'rejected' && entry.outcome?.resourceId === row.targetId);
    if (!fits)
      problems.push(`ledger row ${row.admissionId} (${row.outcome}) does not match its entry: ${entry.state}`);
  }
  for (const entry of entries) {
    if (rowOf.has(entry.admissionId)) continue;
    if (entry.state === 'consumed') problems.push(`entry ${entry.admissionId} is consumed without a ledger row`);
    else if (entry.state === 'expired' && entry.fingerprint)
      problems.push(`entry ${entry.admissionId} was claimed and expired without a closed row`);
  }
  return problems;
}
