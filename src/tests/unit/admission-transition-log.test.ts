import {
  parseMonitorLine,
  replayAdmissionLog,
  MonitorEntry,
} from '../helpers/admission-transition-log';

// Lines as `redis-cli MONITOR` prints them; a command a script ran has the source `lua`.
const EVENT = '11111111-1111-4111-8111-111111111111';
const EPOCH = '22222222-2222-4222-8222-222222222222';
const NEXT_EPOCH = '33333333-3333-4333-8333-333333333333';
const T0 = 1_700_000_000_000;
const control = `peakpass:admission:${EVENT}:control`;
const key = (name: string, epoch = EPOCH) => `peakpass:admission:${EVENT}:${epoch}:${name}`;
const quote = (value: string) =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
const line = (ms: number, source: string, ...args: string[]) =>
  `${(ms / 1000).toFixed(6)} [0 ${source}] ${args.map(quote).join(' ')}`;
const lua = (ms: number, ...args: string[]) => line(ms, 'lua', ...args);

const join = (id: string, sequence: number, ms = T0, epoch = EPOCH) => [
  lua(ms, 'ZADD', key('waiting', epoch), String(sequence), id),
  lua(ms, 'ZADD', key('leases', epoch), String(ms + 120000), id),
];
// The promotion of the tick script: out of waiting, into active, counted in the rolling window.
const promote = (id: string, now: number, epoch = EPOCH) => [
  lua(now, 'ZREM', key('waiting', epoch), id),
  lua(now, 'ZREM', key('leases', epoch), id),
  lua(now, 'ZADD', key('active', epoch), String(now + 30000), id),
  lua(now, 'ZADD', key('window', epoch), String(now), id),
];
const claim = (id: string, now: number) => [
  lua(now, 'ZADD', key('claims'), String(now + 15000), id),
];
const finish = (id: string, now: number) =>
  ['waiting', 'leases', 'active', 'claims'].map((name) => lua(now, 'ZREM', key(name), id));
const publish = (generation: string, epoch: string, now: number, runId = 'r1') => [
  lua(now, 'HSET', control, 'generation', generation, 'epoch', epoch, 'mode', 'initializing', 'runId', runId, 'dirty', '1'),
  lua(now, 'ZADD', key('active', epoch), '+inf', '__'),
  lua(now, 'ZADD', key('waiting', epoch), '+inf', '__'),
  lua(now, 'HDEL', control, 'dirty'),
  lua(now + 1, 'HSET', control, 'mode', 'ready'),
];
const replay = (lines: string[]) =>
  replayAdmissionLog(lines.map(parseMonitorLine).filter((e): e is MonitorEntry => e !== null));
const rules = (lines: string[]) => replay(lines).violations.map((v) => v.rule);
// Admits `count` entries half a second apart, so the rate bound is never the one that breaks.
const admitted = (count: number, epoch = EPOCH) =>
  Array.from({ length: count }, (_, i) => [
    ...join(`a${i}`, i + 1, T0, epoch),
    ...promote(`a${i}`, T0 + 1000 + i * 500, epoch),
  ]).flat();

describe('MONITOR line parsing', () => {
  it('reads the time, the source and arguments with quotes, backslashes and escapes', () => {
    const entry = parseMonitorLine(
      '1700000000.250001 [0 lua] "HSET" "k" "a \\"quoted\\" \\\\ value\\n\\x41"',
    );
    expect(entry).toEqual({
      time: 1700000000250.001,
      source: 'lua',
      args: ['HSET', 'k', 'a "quoted" \\ value\nA'],
    });
  });

  it('reads a client address as the source and ignores a line that is no command', () => {
    expect(parseMonitorLine('1700000000.000000 [0 172.18.0.5:51234] "PING"')).toEqual({
      time: 1700000000000,
      source: '172.18.0.5:51234',
      args: ['PING'],
    });
    expect(parseMonitorLine('OK')).toBeNull();
    expect(parseMonitorLine('')).toBeNull();
  });
});

describe('replay of the admission transition log', () => {
  it('accepts eight entries in use and reports the ninth as a capacity violation', () => {
    expect(rules([...publish('1', EPOCH, T0), ...admitted(8)])).toEqual([]);
    expect(rules([...publish('1', EPOCH, T0), ...admitted(9)])).toEqual(['capacity']);
  });

  it('counts a returned slot: a ninth admission after one finished is within capacity', () => {
    const result = replay([
      ...publish('1', EPOCH, T0),
      ...admitted(8),
      ...finish('a0', T0 + 6000),
      ...join('late', 9),
      ...promote('late', T0 + 7000),
    ]);
    expect(result.violations).toEqual([]);
    expect(result.promotions).toBe(9);
    expect(result.namespaces.get(`${EVENT}:${EPOCH}`)!.active).toHaveLength(8);
    expect(result.namespaces.get(`${EVENT}:${EPOCH}`)!.active).not.toContain('a0');
  });

  it('accepts two promotions in a rolling second and reports the third', () => {
    const queue = [...join('a', 1), ...join('b', 2), ...join('c', 3)];
    const start = [...publish('1', EPOCH, T0), ...queue];
    expect(rules([...start, ...promote('a', T0 + 1000), ...promote('b', T0 + 1010)])).toEqual([]);
    expect(
      rules([...start, ...promote('a', T0 + 1000), ...promote('b', T0 + 1010), ...promote('c', T0 + 1999)]),
    ).toEqual(['rate']);
  });

  it('treats the rolling second as (t-1000, t]: a promotion exactly 1000 ms later is outside', () => {
    expect(
      rules([
        ...publish('1', EPOCH, T0),
        ...join('a', 1),
        ...join('b', 2),
        ...join('c', 3),
        ...promote('a', T0 + 1000),
        ...promote('b', T0 + 1001),
        ...promote('c', T0 + 2000),
      ]),
    ).toEqual([]);
  });

  it('counts a promotion from the slot it takes, also when the product recorded no window entry', () => {
    // The instant of a promotion is the score of its slot minus the admission TTL. A product
    // that promoted without counting must not pass because its own count is what was read.
    const uncounted = (id: string, now: number) => promote(id, now).slice(0, 3);
    expect(
      rules([
        ...publish('1', EPOCH, T0),
        ...join('a', 1),
        ...join('b', 2),
        ...join('c', 3),
        ...uncounted('a', T0 + 1000),
        ...uncounted('b', T0 + 1010),
        ...uncounted('c', T0 + 1999),
      ]),
    ).toEqual(['rate']);
  });

  it('reports an entry that takes a slot without having left the waiting line', () => {
    expect(
      rules([...publish('1', EPOCH, T0), lua(T0 + 1000, 'ZADD', key('active'), String(T0 + 31000), 'ghost')]),
    ).toEqual(['fifo']);
  });

  it('reports an entry that is promoted a second time', () => {
    expect(
      rules([
        ...publish('1', EPOCH, T0),
        ...join('a', 1),
        ...promote('a', T0 + 1000),
        ...finish('a', T0 + 2000),
        ...promote('a', T0 + 5000),
      ]),
    ).toEqual(['repromotion']);
  });

  it('reports a promotion that leaves a lower sequence waiting', () => {
    expect(
      rules([...publish('1', EPOCH, T0), ...join('a', 1), ...join('b', 2), ...promote('b', T0 + 1000)]),
    ).toEqual(['fifo']);
  });

  it('reports a claim for an entry that holds no slot', () => {
    expect(
      rules([...publish('1', EPOCH, T0), ...join('a', 1), ...claim('a', T0 + 1000)]),
    ).toEqual(['claim-without-slot']);
    expect(
      rules([...publish('1', EPOCH, T0), ...join('a', 1), ...promote('a', T0 + 1000), ...claim('a', T0 + 1500)]),
    ).toEqual([]);
  });

  it('reports a generation that is published below one already published', () => {
    const lost = [...publish('3', EPOCH, T0), line(T0 + 10, '172.18.0.9:40000', 'FLUSHALL')];
    expect(rules([...lost, ...publish('4', NEXT_EPOCH, T0 + 20)])).toEqual([]);
    expect(rules([...lost, ...publish('2', NEXT_EPOCH, T0 + 20)])).toContain('generation');
    // The same generation never stands for two epochs.
    expect(rules([...lost, ...publish('3', NEXT_EPOCH, T0 + 20)])).toContain('generation');
  });

  it('reports a published generation that is opened again after its keys were lost or frozen', () => {
    const ready = publish('3', EPOCH, T0);
    // Publishing an intact ready generation again is the idempotent case.
    expect(rules([...ready, lua(T0 + 5, 'HSET', control, 'mode', 'ready')])).toEqual([]);
    expect(
      rules([...ready, line(T0 + 10, '172.18.0.9:40000', 'FLUSHALL'), ...publish('3', EPOCH, T0 + 20)]),
    ).toEqual(['generation']);
    expect(
      rules([
        ...ready,
        lua(T0 + 5, 'HSET', control, 'mode', 'frozen'),
        lua(T0 + 6, 'HSET', control, 'mode', 'ready'),
      ]),
    ).toEqual(['generation']);
  });

  it('reports a namespace initialized under the run id of a server process that is gone', () => {
    const parse = (lines: string[]) => lines.map(parseMonitorLine).filter((e): e is MonitorEntry => e !== null);
    // The fixture marks the moment it replaced the server process; nothing of the old one is left.
    const restarted: MonitorEntry = { time: T0 + 10, source: 'fixture:restart', args: ['FLUSHALL'] };
    const before = parse(publish('1', EPOCH, T0, 'old-process'));
    expect(
      replayAdmissionLog([...before, restarted, ...parse(publish('2', NEXT_EPOCH, T0 + 20, 'new-process'))]).violations,
    ).toEqual([]);
    expect(
      replayAdmissionLog([...before, restarted, ...parse(publish('2', NEXT_EPOCH, T0 + 20, 'old-process'))])
        .violations.map((v) => v.rule),
    ).toEqual(['run-id']);
    // An emptied server of the same process keeps its run id: that is no violation.
    expect(
      rules([...publish('1', EPOCH, T0, 'same'), line(T0 + 10, '172.18.0.9:40000', 'FLUSHALL'), ...publish('2', NEXT_EPOCH, T0 + 20, 'same')]),
    ).toEqual([]);
  });

  it('lists every control change in order', () => {
    const result = replay([...publish('1', EPOCH, T0), lua(T0 + 5, 'HSET', control, 'mode', 'frozen')]);
    expect(result.controls.map((c) => [c.generation, c.epoch, c.mode])).toEqual([
      ['1', EPOCH, 'initializing'],
      ['1', EPOCH, 'ready'],
      ['1', EPOCH, 'frozen'],
    ]);
  });

  it('forgets a namespace that was unlinked or flushed', () => {
    const unlinked = replay([
      ...publish('1', EPOCH, T0),
      ...admitted(8),
      line(T0 + 9000, '172.18.0.9:40000', 'UNLINK', control, key('active'), key('waiting'), key('claims')),
      ...publish('2', NEXT_EPOCH, T0 + 9100),
      ...admitted(8, NEXT_EPOCH),
    ]);
    expect(unlinked.violations.filter((v) => v.rule === 'capacity')).toEqual([]);
    expect(unlinked.namespaces.has(`${EVENT}:${EPOCH}`)).toBe(false);

    const flushed = replay([
      ...publish('1', EPOCH, T0),
      ...admitted(8),
      line(T0 + 9000, '172.18.0.9:40000', 'FLUSHALL'),
    ]);
    expect(flushed.namespaces.size).toBe(0);
  });

  it('ignores the sentinel member and keys outside the admission namespace', () => {
    const result = replay([
      ...publish('1', EPOCH, T0),
      lua(T0, 'ZADD', key('claims'), '+inf', '__'),
      lua(T0, 'ZADD', `peakpass:admission:${EVENT}:limit:u1:status`, String(T0), 'r1'),
      line(T0, '172.18.0.9:40000', 'ZADD', 'peakpass:ratelimit:reservation:u1', String(T0), 'x'),
    ]);
    expect(result.violations).toEqual([]);
    expect(result.namespaces.get(`${EVENT}:${EPOCH}`)).toEqual({ waiting: [], active: [], claims: [] });
  });
});
