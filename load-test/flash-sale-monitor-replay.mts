// Replay of a verification run's MONITOR capture. The fixture runs it with tsx after the Redis dump:
//   tsx load-test/flash-sale-monitor-replay.mts <run directory> <rate> <capacity> <ttlMs>
// It reads redis-monitor.txt and redis-admission.json and writes monitor-replay.json. The rules are those of
// the P7 helper; the verdict is the analysis's (flash-sale-analysis.mjs), not this script's.
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { parseMonitorLine, replayAdmissionLog, type MonitorEntry } from '../src/tests/helpers/admission-transition-log.ts';

const [directory, rate, capacity, ttlMs] = process.argv.slice(2);
const profile = { rate: Number(rate), capacity: Number(capacity), ttlMs: Number(ttlMs) };
if (!directory || !Object.values(profile).every(Number.isFinite)) throw new Error('usage: flash-sale-monitor-replay.mts <run directory> <rate> <capacity> <ttlMs>');
const dump = JSON.parse(await readFile(join(directory, 'redis-admission.json'), 'utf8'));

const entries: MonitorEntry[] = [];
let lines = 0, unparsed = 0;
for await (const line of createInterface({ input: createReadStream(join(directory, 'redis-monitor.txt'), 'latin1') })) {
  if (!line) continue;
  lines++;
  const entry = parseMonitorLine(line);
  if (entry) entries.push(entry); else unparsed++;
}
const replay = replayAdmissionLog(entries, profile);
const namespace = `${dump.eventId}:${dump.epoch}`, last = replay.namespaces.get(namespace);
const ids = (list: { id: string }[] | undefined) => (list ?? []).map(member => member.id).filter(id => id !== '__').sort();
const sets = Object.fromEntries((['waiting', 'active', 'claims'] as const).map(name => {
  const replayed = [...(last?.[name] ?? [])].sort(), dumped = ids(dump[name]);
  return [name, { replayed: replayed.length, dumped: dumped.length, equal: JSON.stringify(replayed) === JSON.stringify(dumped) }];
}));
await writeFile(join(directory, 'monitor-replay.json'), JSON.stringify({
  profile, lines, unparsed, promotions: replay.promotions,
  promotedEntriesInDump: (dump.entries ?? []).filter((entry: { admittedAt: unknown }) => Number.isFinite(entry.admittedAt)).length,
  namespaces: [...replay.namespaces.keys()], dumpNamespace: namespace, controls: replay.controls, violations: replay.violations, sets,
}, null, 2));
console.log(`replayed ${lines} lines: ${replay.promotions} promotions, ${replay.violations.length} violations`);
