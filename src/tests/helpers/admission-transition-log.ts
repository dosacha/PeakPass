/**
 * The Redis transition log of admission-v1 §8, read from a `MONITOR` stream.
 *
 * MONITOR reports every command the server runs, including the ones a Lua script issues (source
 * `lua`), in the order Redis applied them. Replaying the writes to the waiting, active and claims
 * sets therefore gives the capacity in use after every command and the promotions of every
 * rolling second, which a sampled read cannot.
 */
export interface MonitorEntry {
  /** Redis server time of the command, in milliseconds. */
  time: number;
  /** `lua` for a command issued by a script, otherwise the client address. */
  source: string;
  args: string[];
}
export type ReplayRule =
  | 'capacity'
  | 'rate'
  | 'repromotion'
  | 'fifo'
  | 'claim-without-slot'
  | 'generation'
  | 'run-id';
export interface ReplayViolation {
  rule: ReplayRule;
  detail: string;
  time: number;
}
export interface ControlChange {
  eventId: string;
  generation: string;
  epoch: string;
  mode: string;
  time: number;
}
export interface Replay {
  violations: ReplayViolation[];
  /** Successful promotions, over every namespace. */
  promotions: number;
  /** Members at the end of the log, by `<eventId>:<epoch>`, without the sentinel. */
  namespaces: Map<string, { waiting: string[]; active: string[]; claims: string[] }>;
  controls: ControlChange[];
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b' };

/** One line as `redis-cli MONITOR` prints it, or the text of the simple string Redis pushes. */
export function parseMonitorLine(line: string): MonitorEntry | null {
  const head = /^(\d+\.\d+) \[\d+ ([^\]]+)\] /.exec(line);
  if (!head) return null;
  const args: string[] = [];
  let i = head[0].length;
  while (i < line.length) {
    if (line[i] !== '"') {
      i++;
      continue;
    }
    let value = '';
    for (i++; i < line.length && line[i] !== '"'; i++) {
      if (line[i] !== '\\') {
        value += line[i];
        continue;
      }
      const next = line[++i];
      if (next === 'x') {
        value += String.fromCharCode(parseInt(line.slice(i + 1, i + 3), 16));
        i += 2;
      } else value += ESCAPES[next] ?? next;
    }
    args.push(value);
    i++;
  }
  return { time: Number(head[1]) * 1000, source: head[2], args };
}

interface Namespace {
  waiting: Map<string, number>;
  active: Set<string>;
  claims: Set<string>;
  promoted: Set<string>;
  window: number[];
  /** Sequence of an entry that just left waiting, read when it enters active. */
  left: Map<string, number>;
  /** Every sequence given out in this namespace, with the entry that holds it. */
  sequences: Map<number, string>;
}
interface Control {
  generation: string;
  epoch: string;
  mode: string;
}
interface Published {
  generation: bigint;
  epoch: string;
  /** The published keys were unlinked or flushed, or the generation was frozen. */
  closed: boolean;
}

const KEY = /^peakpass:admission:([0-9a-f-]{36}):(?:(control)|([0-9a-f-]{36}):(\w+))$/;

export function replayAdmissionLog(
  entries: MonitorEntry[],
  profile: { rate: number; capacity: number; ttlMs?: number } = { rate: 2, capacity: 8 },
): Replay {
  const ttlMs = profile.ttlMs ?? 30000;
  const violations: ReplayViolation[] = [];
  const namespaces = new Map<string, Namespace>();
  const current = new Map<string, Control>();
  const published = new Map<string, Published>();
  const controls: ControlChange[] = [];
  // Run ids seen in controls: of the server process that is running, and of those replaced.
  const alive = new Set<string>();
  const gone = new Set<string>();
  let promotions = 0;

  const namespace = (id: string) => {
    let found = namespaces.get(id);
    if (!found) {
      found = {
        waiting: new Map(),
        active: new Set(),
        claims: new Set(),
        promoted: new Set(),
        window: [],
        left: new Map(),
        sequences: new Map(),
      };
      namespaces.set(id, found);
    }
    return found;
  };
  const report = (rule: ReplayRule, time: number, detail: string) =>
    violations.push({ rule, detail, time });
  const lose = (eventId: string) => {
    current.delete(eventId);
    const last = published.get(eventId);
    if (last) last.closed = true;
  };

  function setControl(eventId: string, fields: string[], time: number) {
    const before = current.get(eventId);
    const control: Control = { generation: '', epoch: '', mode: '', ...before };
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (fields[i] === 'generation' || fields[i] === 'epoch' || fields[i] === 'mode')
        control[fields[i] as keyof Control] = fields[i + 1];
      if (fields[i] !== 'runId') continue;
      // The run id names the Redis process that holds the namespace.
      if (gone.has(fields[i + 1]))
        report('run-id', time, `event ${eventId} was initialized under the run id of a process that is gone`);
      else alive.add(fields[i + 1]);
    }
    // The dirty bit and a repeated publication of an intact ready generation change nothing here.
    if (
      control.generation === (before?.generation ?? '') &&
      control.epoch === (before?.epoch ?? '') &&
      control.mode === (before?.mode ?? '')
    )
      return;
    current.set(eventId, control);
    controls.push({ eventId, ...control, time });
    const last = published.get(eventId);
    const generation = BigInt(control.generation || '0');
    const where = `event ${eventId} generation ${control.generation} epoch ${control.epoch}`;
    if (control.mode === 'frozen') {
      if (last && last.generation === generation && last.epoch === control.epoch) last.closed = true;
      return;
    }
    if (last && generation < last.generation) {
      report('generation', time, `${control.mode} below published generation ${last.generation}: ${where}`);
      return;
    }
    if (control.mode !== 'ready') return;
    if (last && generation === last.generation) {
      if (last.epoch !== control.epoch)
        report('generation', time, `published generation reused for another epoch: ${where}`);
      else if (last.closed)
        report('generation', time, `published generation opened again after it was lost or frozen: ${where}`);
      return;
    }
    published.set(eventId, { generation, epoch: control.epoch, closed: false });
  }

  for (const { time, source, args } of entries) {
    const command = args[0]?.toUpperCase();
    // The capture marks a replaced server process: it starts empty and under another run id.
    if (source === 'fixture:restart') {
      for (const runId of alive) gone.add(runId);
      alive.clear();
    }
    if (command === 'FLUSHALL' || command === 'FLUSHDB') {
      namespaces.clear();
      for (const eventId of [...current.keys()]) lose(eventId);
      continue;
    }
    if (command === 'UNLINK' || command === 'DEL') {
      for (const name of args.slice(1)) {
        const key = KEY.exec(name);
        if (!key) continue;
        if (key[2]) lose(key[1]);
        // A namespace is retired as a whole: its control structures go in the same command.
        else if (key[4] === 'active' || key[4] === 'waiting') namespaces.delete(`${key[1]}:${key[3]}`);
      }
      continue;
    }
    if (command !== 'ZADD' && command !== 'ZREM' && command !== 'HSET') continue;
    const key = KEY.exec(args[1] ?? '');
    if (!key) continue;
    const eventId = key[1];
    if (key[2]) {
      if (command === 'HSET') setControl(eventId, args.slice(2), time);
      continue;
    }
    const id = `${eventId}:${key[3]}`;
    const structure = key[4];
    if (command === 'ZREM') {
      const ns = namespace(id);
      for (const member of args.slice(2)) {
        if (structure === 'waiting' && ns.waiting.has(member)) {
          ns.left.set(member, ns.waiting.get(member)!);
          ns.waiting.delete(member);
        } else if (structure === 'active' || structure === 'claims') {
          // A promotion takes an entry out of the line and into a slot. A cancel or an expiry
          // takes it out of every set: an entry that left the line that way was not promoted.
          ns.left.delete(member);
          if (structure === 'active') ns.active.delete(member);
          else ns.claims.delete(member);
        }
      }
      continue;
    }
    if (command !== 'ZADD') continue;
    const score = args[2];
    const member = args[3];
    if (member === undefined || member === '__') {
      if (member === '__') namespace(id);
      continue;
    }
    const ns = namespace(id);
    if (structure === 'waiting') {
      const sequence = Number(score);
      const holder = ns.sequences.get(sequence);
      // §4: a sequence is given once in an epoch. Two entries that share one have no order.
      if (holder !== undefined && holder !== member)
        report('fifo', time, `sequence ${sequence} was given to ${holder} and to ${member} in ${id}`);
      ns.sequences.set(sequence, member);
      ns.waiting.set(member, sequence);
    } else if (structure === 'active') {
      promotions++;
      const sequence = ns.left.get(member);
      if (ns.promoted.has(member)) report('repromotion', time, `${member} entered active again in ${id}`);
      else if (sequence === undefined)
        report('fifo', time, `${member} entered active without having left waiting in ${id}`);
      const ahead = [...ns.waiting].filter(([, other]) => sequence !== undefined && other < sequence);
      if (ahead.length)
        report('fifo', time, `${member} (sequence ${sequence}) was promoted before ${ahead.map(([m]) => m).join(', ')} in ${id}`);
      ns.left.delete(member);
      ns.promoted.add(member);
      ns.active.add(member);
      if (ns.active.size > profile.capacity)
        report('capacity', time, `${ns.active.size} entries in use in ${id}, capacity ${profile.capacity}`);
      // The slot's score is the script's `now` plus the admission TTL. The rate is counted from
      // these instants, not from the window the product keeps for itself. Like the capacity it is
      // the bound of one epoch: §4 keeps the promotion history in the epoch's namespace, and a
      // reset (§6) starts a new one.
      const now = Number(score) - ttlMs;
      ns.window.push(now);
      const inSecond = ns.window.filter((t) => t > now - 1000 && t <= now).length;
      if (inSecond > profile.rate)
        report('rate', time, `${inSecond} promotions in (${now - 1000}, ${now}] in ${id}, rate ${profile.rate}`);
    } else if (structure === 'claims') {
      if (!ns.active.has(member)) report('claim-without-slot', time, `${member} claimed without a slot in ${id}`);
      ns.claims.add(member);
    }
  }

  return {
    violations,
    promotions,
    namespaces: new Map(
      [...namespaces].map(([id, ns]) => [
        id,
        { waiting: [...ns.waiting.keys()], active: [...ns.active], claims: [...ns.claims] },
      ]),
    ),
    controls,
  };
}
