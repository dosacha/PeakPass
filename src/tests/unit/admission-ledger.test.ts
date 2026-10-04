import { ledgerMismatches, LedgerRow, RedisEntry } from '../helpers/admission-ledger';

const row = (admissionId: string, outcome: LedgerRow['outcome'], extra: Partial<LedgerRow> = {}): LedgerRow => ({
  admissionId,
  operation: 'reservation',
  outcome,
  targetId: null,
  errorCode: null,
  ...extra,
});
const entry = (admissionId: string, state: string, extra: Partial<RedisEntry> = {}): RedisEntry => ({
  admissionId,
  state,
  phase: 'idle',
  ...extra,
});

describe('ledger rows against the Redis entries of one epoch', () => {
  it('accepts every final pair the product produces', () => {
    expect(
      ledgerMismatches(
        [
          row('bought', 'consumed', { targetId: 'r1' }),
          row('sold-out', 'rejected', { errorCode: 'INSUFFICIENT_INVENTORY' }),
          row('abandoned', 'closed', { errorCode: 'ADMISSION_EXPIRED' }),
        ],
        [
          entry('bought', 'consumed', { fingerprint: 'f', outcome: { kind: 'reservation', resourceId: 'r1' } }),
          entry('sold-out', 'consumed', { fingerprint: 'f', outcome: { kind: 'rejected', code: 'INSUFFICIENT_INVENTORY' } }),
          entry('abandoned', 'expired', { fingerprint: 'f' }),
          // Never claimed: an idle admission that ran out, a cancelled one and one still waiting.
          entry('idle', 'expired'),
          entry('left', 'cancelled'),
          entry('queued', 'waiting'),
          entry('inside', 'admitted'),
        ],
      ),
    ).toEqual([]);
  });

  it('skips an entry whose claim is still open, with or without its ledger row', () => {
    expect(
      ledgerMismatches(
        [row('committed', 'consumed', { targetId: 'r1' })],
        [
          entry('committed', 'admitted', { phase: 'processing', fingerprint: 'f' }),
          entry('running', 'admitted', { phase: 'reconciling', fingerprint: 'f' }),
        ],
      ),
    ).toEqual([]);
  });

  it('reports a slot that was returned without a durable reason', () => {
    expect(ledgerMismatches([], [entry('a', 'consumed', { fingerprint: 'f', outcome: { kind: 'reservation', resourceId: 'r1' } })])).toEqual([
      'entry a is consumed without a ledger row',
    ]);
    expect(ledgerMismatches([], [entry('b', 'expired', { fingerprint: 'f' })])).toEqual([
      'entry b was claimed and expired without a closed row',
    ]);
    // A claim ends consumed or closed. A claimed entry in any other state gave its slot back
    // without either; one that was never claimed needs no row.
    expect(
      ledgerMismatches([], [entry('c', 'cancelled', { fingerprint: 'f' }), entry('d', 'cancelled')]),
    ).toEqual(['entry c was claimed and is cancelled without a ledger row']);
  });

  it('reports a ledger row whose entry is missing or tells another story', () => {
    expect(ledgerMismatches([row('a', 'consumed', { targetId: 'r1' })], [])).toEqual([
      'ledger row a (consumed) has no Redis entry',
    ]);
    expect(
      ledgerMismatches(
        [row('a', 'consumed', { targetId: 'r1' })],
        [entry('a', 'consumed', { fingerprint: 'f', outcome: { kind: 'reservation', resourceId: 'r2' } })],
      ),
    ).toEqual(['ledger row a (consumed) does not match its entry: consumed']);
    expect(
      ledgerMismatches([row('a', 'closed')], [entry('a', 'consumed', { fingerprint: 'f', outcome: { kind: 'reservation', resourceId: 'r1' } })]),
    ).toEqual(['ledger row a (closed) does not match its entry: consumed']);
    expect(ledgerMismatches([row('a', 'consumed', { targetId: 'r1' })], [entry('a', 'cancelled')])).toEqual([
      'ledger row a (consumed) does not match its entry: cancelled',
    ]);
    // The entry tells the purchase of the row: a reservation is not a direct checkout, and an
    // outcome without a kind is none.
    expect(
      ledgerMismatches(
        [row('a', 'consumed', { targetId: 'r1' })],
        [entry('a', 'consumed', { fingerprint: 'f', outcome: { kind: 'direct-checkout', resourceId: 'r1' } })],
      ),
    ).toEqual(['ledger row a (consumed) does not match its entry: consumed']);
    expect(
      ledgerMismatches(
        [row('a', 'consumed', { operation: 'direct-checkout', targetId: 'o1' })],
        [entry('a', 'consumed', { fingerprint: 'f', outcome: { resourceId: 'o1' } })],
      ),
    ).toEqual(['ledger row a (consumed) does not match its entry: consumed']);
    expect(
      ledgerMismatches(
        [row('a', 'consumed', { operation: 'direct-checkout', targetId: 'o1' })],
        [entry('a', 'consumed', { fingerprint: 'f', outcome: { kind: 'direct-checkout', resourceId: 'o1' } })],
      ),
    ).toEqual([]);
    expect(
      ledgerMismatches(
        [row('a', 'rejected', { errorCode: 'INSUFFICIENT_INVENTORY' })],
        [entry('a', 'consumed', { fingerprint: 'f', outcome: { kind: 'reservation', resourceId: 'r1' } })],
      ),
    ).toEqual(['ledger row a (rejected) does not match its entry: consumed']);
  });
});
