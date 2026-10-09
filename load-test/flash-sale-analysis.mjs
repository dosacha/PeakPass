// Offline analysis of preserved evidence; never changes the original run.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const ANALYSIS_REVISION = 'flash-sale-analysis-v3.3';

export function stats(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  const percentile = p => { const n = (a.length - 1) * p, i = Math.floor(n); return a.length ? a[i] + (a[Math.ceil(n)] - a[i]) * (n - i) : null; };
  return { count: a.length, min: a[0] ?? null, median: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: a.at(-1) ?? null };
}
const epoch = value => typeof value === 'number' ? value : Date.parse(value);
const inside = (value, start, end) => epoch(value) >= start && epoch(value) < end;

export function coverage(samples, start, end, maxGapMs) {
  const times = samples.map(o => epoch(o.at ?? o.time)).filter(Number.isFinite).sort((a, b) => a - b);
  const relevant = times.filter(t => t >= start - maxGapMs && t <= end + maxGapMs);
  const gaps = relevant.slice(1).map((t, i) => t - relevant[i]);
  const maxGap = Math.max(0, ...gaps, relevant[0] - start, end - relevant.at(-1));
  const errors = samples.filter(o => o.error && inside(o.at ?? o.time, start - maxGapMs, end + maxGapMs)).length;
  return { count: relevant.length, first: relevant[0] ?? null, last: relevant.at(-1) ?? null, maxGapMs: Number.isFinite(maxGap) ? maxGap : null, errors,
    complete: relevant.length >= 2 && errors === 0 && maxGap <= maxGapMs && relevant[0] <= start + maxGapMs && relevant.at(-1) >= end - maxGapMs };
}

export function classify({ integrity, valid, stable, stock }) {
  return !integrity ? 'integrity-defect' : !valid ? 'invalid-measurement' : stock === 'limited' ? 'valid-limited' : stable ? 'valid-stable' : 'valid-overload';
}

export function generatorObserved(samples, start, end, loadEndedAt) {
  const healthy = o => Number.isFinite(o.generator?.cpuSeconds)
    && o.generator.processes?.some(p => p.path && p.isShim === false && Number.isFinite(p.cpuSeconds) && p.cpuSeconds >= 0 && p.memoryBytes > 0);
  // A sequential process/Docker query can straddle both window end and normal k6 exit.
  const terminalSample = o => epoch(o.endedAt) >= end && epoch(loadEndedAt) >= epoch(o.at) && epoch(loadEndedAt) <= epoch(o.endedAt);
  return samples.filter(o => inside(o.at, start, end)).every(o => healthy(o) || terminalSample(o))
    && coverage(samples.filter(healthy), start, end, 6000).complete;
}

export function metricAccounting(points, summary, offered) {
  const select = metric => points.filter(p => p.metric === metric);
  const sum = metric => select(metric).reduce((n, p) => n + p.data.value, 0);
  const key = p => Object.entries(p.data.tags).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('/');
  const bag = metric => { const b = {}; for (const p of select(metric)) b[key(p)] = (b[key(p)] ?? 0) + 1; return Object.entries(b).sort().map(JSON.stringify).join('\n'); };
  const buyers = metric => JSON.stringify(select(metric).map(p => p.data.tags.buyer).sort());
  const expectedBuyers = JSON.stringify(Array.from({ length: offered }, (_, i) => String(i)).sort());
  const checks = {
    offeredBuyers: Number.isSafeInteger(offered) && offered > 0 && buyers('buyers_started') === expectedBuyers && buyers('journey_outcomes') === expectedBuyers,
    attempts: bag('api_responses') === bag('api_duration') && sum('api_responses') === (summary.http_reqs?.count ?? 0),
    journeys: bag('journey_outcomes') === bag('journey_duration') && select('journey_outcomes').length === (summary.iterations?.count ?? 0)
      && select('journey_outcomes').length === sum('buyers_started') && buyers('journey_outcomes') === buyers('buyers_started'),
    arrivalMetrics: select('active_vus_at_arrival').length === sum('buyers_started') && select('arrival_lag_ms').length === sum('buyers_started'),
    summaryCounts: ['buyers_started', 'buyers_completed', 'dropped_iterations', 'script_failures', 'protocol_failures', 'replay_failures'].every(k => sum(k) === (summary[k]?.count ?? 0)),
  };
  return { checks, complete: Object.values(checks).every(Boolean) };
}

export function analyzePoints(points, manifest, sql) {
  const s = manifest.settings;
  const select = metric => points.filter(p => p.metric === metric);
  const count = metric => select(metric).reduce((sum, p) => sum + p.data.value, 0);
  const start = select('scenario_start_ms')[0]?.data.value;
  assert.ok(Number.isFinite(start), 'Missing scenario epoch');
  const left = start + s.warmupSeconds * 1000, right = start + s.durationSeconds * 1000;
  const inWindow = p => inside(p.data.time, left, right);
  const buyer = p => Number(p.data.tags.buyer);
  const measured = p => buyer(p) >= s.warmupSeconds * s.rate && buyer(p) < s.users;
  const paidOrders = new Map(sql.orders.filter(o => o.status === 'paid').map(o => [o.user_id, o]));
  const paidUsers = new Set(paidOrders.keys());
  const starts = select('buyers_started'), completions = select('buyers_completed');
  const ticketsByOrder = new Map();
  for (const ticket of sql.tickets ?? []) {
    if (!ticketsByOrder.has(ticket.order_id)) ticketsByOrder.set(ticket.order_id, []);
    ticketsByOrder.get(ticket.order_id).push(ticket.id);
  }
  const identities = new Map(completions.map(p => {
    try {
      const orderId = p.data.tags.order_id, ids = JSON.parse(p.data.tags.ticket_ids);
      if (typeof orderId === 'string' && orderId.length > 0 && Array.isArray(ids) && ids.length > 0
        && ids.every(id => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length) return [p, { orderId, ids: ids.sort() }];
    } catch { /* Missing or malformed captured identity is incomplete evidence. */ }
    return [p, null];
  }));
  const matchesSql = p => {
    const order = paidOrders.get(manifest.fixture.userIds[buyer(p)]), identity = identities.get(p);
    return order && identity && identity.orderId === order.id && JSON.stringify(identity.ids) === JSON.stringify((ticketsByOrder.get(order.id) ?? []).sort());
  };
  const confirmed = completions.filter(matchesSql);
  const windowPaid = confirmed.filter(inWindow), cohortPaid = confirmed.filter(measured);
  const journeys = select('journey_duration').filter(measured);
  const responsePoints = select('api_responses');
  const windowResponses = responsePoints.filter(inWindow);
  const attempts = windowResponses.filter(p => p.data.tags.kind !== 'replay');
  const counts = {}, latencies = {}, outcomes = {};
  for (const p of responsePoints) {
    const t = p.data.tags, key = [t.stage, t.kind, t.flow, t.status, t.error_code, t.code, t.business].join('/');
    counts[key] = (counts[key] ?? 0) + p.data.value;
  }
  for (const p of select('api_duration').filter(inWindow)) {
    const t = p.data.tags, key = [t.stage, t.kind, t.flow, t.status, t.error_code, t.code, t.business].join('/');
    (latencies[key] ??= []).push(p.data.value);
  }
  for (const p of select('journey_outcomes').filter(measured)) outcomes[p.data.tags.outcome] = (outcomes[p.data.tags.outcome] ?? 0) + p.data.value;
  const firstHalf = windowPaid.filter(p => epoch(p.data.time) < (left + right) / 2).length;
  const secondHalf = windowPaid.length - firstHalf;
  const failureAttempts = attempts.filter(p => p.data.tags.status === '0' || p.data.tags.status === '429' || Number(p.data.tags.status) >= 500).length;
  const unique = list => new Set(list.map(buyer)).size;
  const cohortOffered = s.users - s.warmupSeconds * s.rate;
  return {
    window: { start: new Date(left).toISOString(), endExclusive: new Date(right).toISOString(), seconds: s.measurementSeconds,
      confirmedPaid: unique(windowPaid), paidPerSecond: unique(windowPaid) / s.measurementSeconds,
      warmupSpillover: windowPaid.filter(p => !measured(p)).length, firstHalfPaidPerSecond: firstHalf / (s.measurementSeconds / 2), secondHalfPaidPerSecond: secondHalf / (s.measurementSeconds / 2),
      nonReplayAttempts: attempts.length, failureAttempts, failureFraction: attempts.length ? failureAttempts / attempts.length : null,
      responseKey: 'stage/kind/flow/status/error_code/code/business', apiLatencyMs: Object.fromEntries(Object.entries(latencies).map(([k, v]) => [k, stats(v)])) },
    cohort: { offered: cohortOffered, started: starts.filter(measured).length, actualWindowArrivals: starts.filter(inWindow).length,
      confirmedPaid: unique(cohortPaid), completionFraction: unique(cohortPaid) / cohortOffered, unfinished: cohortOffered - unique(cohortPaid), outcomes,
      paidJourneyMs: stats(journeys.filter(p => p.data.tags.outcome === 'paid').map(p => p.data.value)),
      allFinishedJourneyMs: stats(journeys.map(p => p.data.value)),
      lastArrival: starts.filter(measured).map(p => epoch(p.data.time)).sort((a,b) => a-b).at(-1) ?? null,
      lastConfirmedCompletion: cohortPaid.map(p => epoch(p.data.time)).sort((a,b) => a-b).at(-1) ?? null,
      maximumDrainEnd: new Date(right - 1 + s.drainSeconds * 1000).toISOString() },
    all: { offered: s.users, started: count('buyers_started'), httpPaid: count('buyers_completed'), sqlPaid: paidUsers.size,
      sqlPaidWithoutHttp: [...paidUsers].filter(id => !completions.some(p => manifest.fixture.userIds[buyer(p)] === id)).length,
      httpPaidWithoutSql: completions.filter(p => !paidUsers.has(manifest.fixture.userIds[buyer(p)])).length,
      missingPaidIdentity: completions.filter(p => !identities.get(p)).length,
      httpPaidIdentityMismatches: completions.filter(p => identities.get(p) && paidUsers.has(manifest.fixture.userIds[buyer(p)]) && !matchesSql(p)).length,
      duplicateStarts: starts.length - unique(starts), duplicateCompletions: completions.length - unique(completions),
      dropped: count('dropped_iterations'), scriptFailures: count('script_failures'), protocolFailures: count('protocol_failures'), replayFailures: count('replay_failures'),
      arrivalLagMs: stats(select('arrival_lag_ms').map(p => p.data.value)), responses: counts,
      maxActiveVUs: Math.max(0, ...select('active_vus_at_arrival').map(p => p.data.value)) },
  };
}

async function jsonLines(path, keep = () => true) {
  const result = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const value = JSON.parse(line); if (keep(value)) result.push(value);
  }
  return result;
}

export async function verifyArtifacts(directory, manifest) {
  assert.ok(manifest.artifactHashes && Object.keys(manifest.artifactHashes).length, 'Missing artifact hashes');
  for (const [file, expected] of Object.entries(manifest.artifactHashes)) {
    assert.ok(!file.includes('/') && !file.includes('\\') && file !== '..', 'Unsafe artifact path');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(directory, file))) hash.update(chunk);
    assert.equal(hash.digest('hex'), expected, `Artifact hash mismatch: ${file}`);
  }
}

export async function analyzeRun(directory, suppliedManifest) {
  const read = name => readFile(join(directory, name), 'utf8').then(JSON.parse);
  const m = suppliedManifest ?? await read('manifest.json');
  if (!suppliedManifest) await verifyArtifacts(directory, m);
  // A v3 run has arms and a queue; everything below this line is the v2.6 analysis, unchanged.
  if (['flash-sale-v3.0', 'flash-sale-v3.1', 'flash-sale-v3.2'].includes(m.revision)) return analyzeV3(directory, m, read);
  const requiredMetrics = new Set(['scenario_start_ms', 'buyers_started', 'buyers_completed', 'journey_outcomes', 'journey_duration',
    'api_responses', 'api_duration', 'arrival_lag_ms', 'active_vus_at_arrival', 'dropped_iterations', 'script_failures', 'protocol_failures', 'replay_failures']);
  const [points, sql, verification, observations, app, resources, cleanup, negatives, summary] = await Promise.all([
    jsonLines(join(directory, 'k6-raw.jsonl'), p => p.type === 'Point' && requiredMetrics.has(p.metric)), read('sql-snapshot.json'), read('verification.json'),
    jsonLines(join(directory, 'observations.jsonl')), read('app-metrics.json'), jsonLines(join(directory, 'resources.jsonl')), read('cleanup.json'), read('negative-checks.json'), read('k6-summary.json'),
  ]);
  const analysis = analyzePoints(points, m, sql), w = analysis.window, a = analysis.all, c = analysis.cohort;
  const left = Date.parse(w.start), right = Date.parse(w.endExclusive), inWindow = row => inside(row.at ?? row.time, left, right);
  const observed = observations.filter(inWindow), pools = app.poolSamples.filter(inWindow), resourceWindow = resources.filter(inWindow);
  const clocks = m.clockChecks ?? [];
  const evidence = {
    sourceClean: m.workingTree === '',
    checkoutProtocol: m.revision === 'flash-sale-v2.6',
    paidIdentityObserved: a.missingPaidIdentity === 0,
    checkoutAuditObserved: verification.integrityNames?.includes('checkoutPaymentIdentity') === true,
    accounting: metricAccounting(points, summary.metrics, m.settings.users),
    observer: coverage(observations, left, right, 1000), pool: coverage(app.poolSamples, left, right, 1000), resources: coverage(resources, left, right, 6000),
    clockAligned: clocks.length === 2 && clocks.every(o => Math.abs(o.offsetMs) + o.roundTripMs / 2 <= 100),
    generatorObserved: generatorObserved(resources, left, right, m.loadEndedAt),
    containersObserved: resourceWindow.length > 0 && resourceWindow.every(o => ['app', 'postgres', 'redis'].every(service => o.containers?.some(c => c.service === service && Number.isFinite(c.cpuPercent) && Number.isFinite(c.memoryPercent)))),
    clean: cleanup.passed === true && !m.cleanupError && !m.teardownError,
    auth: negatives.dataUnchanged === true && negatives.checks.length === 3 && negatives.checks.every(o => o.status === o.expected),
    lifecycle: !m.evidenceErrors?.length && [0, 99].includes(m.k6ExitCode),
  };
  const hostPressure = resourceWindow.some((_, i) => i >= 2 && resourceWindow.slice(i - 2, i + 1).every(o => o.hostCpuPercent >= 90 || o.hostFreeBytes < 1073741824));
  const invalidReasons = [];
  for (const [key, value] of Object.entries(evidence)) if (!(typeof value === 'object' ? value.complete : value)) invalidReasons.push(key);
  if (a.dropped || a.started !== a.offered || a.duplicateStarts || a.duplicateCompletions) invalidReasons.push('arrival-delivery');
  if (a.arrivalLagMs.max === null || a.arrivalLagMs.max > 250) invalidReasons.push('arrival-lag');
  if (a.scriptFailures || a.protocolFailures) invalidReasons.push('script/protocol');
  if (hostPressure) invalidReasons.push('host-pressure');
  if (Object.keys(a.responses).some(k => /\/(401|403|429)\//.test(k))) invalidReasons.push('auth-or-limiter');
  const stable = a.replayFailures === 0 && c.completionFraction >= .99 && w.failureFraction !== null && w.failureFraction <= .01 && c.paidJourneyMs.p99 !== null && c.paidJourneyMs.p99 <= 2000
    && Math.abs(w.firstHalfPaidPerSecond - w.secondHalfPaidPerSecond) / m.settings.rate <= .2;
  const integrity = verification.integrityPassed && a.httpPaidWithoutSql === 0 && a.httpPaidIdentityMismatches === 0;
  return { revision: m.revision, analysisRevision: ANALYSIS_REVISION, runId: m.runId, classification: classify({ integrity, valid: invalidReasons.length === 0, stable, stock: m.settings.stock }),
    smokePassed: m.smokePassed ?? m.passed, k6ExitCode: m.k6ExitCode, invalidReasons, evidence, ...analysis,
    diagnostics: { poolWaiting: stats(pools.map(o => o.waiting)), poolCheckedOut: stats(pools.map(o => o.checkedOut)),
      lockWaiters: stats(observed.map(o => o.activity?.lock_waiters)), lockTypes: [...new Set(observed.flatMap(o => o.locks?.map(l => l.locktype) ?? []))],
      redisObserverRttMs: stats(observed.map(o => o.redisPingRttMs)), retriesScheduledInWindow: app.retrySamples.filter(inWindow).length,
      hostCpuPercent: stats(resourceWindow.map(o => o.hostCpuPercent)), hostFreeBytes: stats(resourceWindow.map(o => o.hostFreeBytes)),
      containers: Object.fromEntries(['app', 'postgres', 'redis'].map(service => [service, {
        cpuPercent: stats(resourceWindow.map(o => o.containers?.find(c => c.service === service)?.cpuPercent)),
        memoryPercent: stats(resourceWindow.map(o => o.containers?.find(c => c.service === service)?.memoryPercent)),
      }])), generatorCpuSeconds: stats(resourceWindow.map(o => o.generator?.cpuSeconds)), generatorMemoryBytes: stats(resourceWindow.map(o => o.generator?.memoryBytes)) },
    sqlCounts: verification.counts, failedSmokeChecks: Object.entries(verification.checks).filter(([, v]) => !v).map(([k]) => k) };
}

// ---- flash-sale-v3.0: arms a, b and c ----
// Purchase writes are these three stages. Status, join and cancel requests of the queue API are never
// part of a purchase error share.
export const PURCHASE_STAGES = ['reservation', 'checkout', 'settlement'];
const QUEUE_STAGES = ['status', 'join', 'cancel'];

/** The largest number of instants inside any (t - windowMs, t]. */
export function rollingMax(times, windowMs = 1000) {
  const sorted = times.filter(Number.isFinite).sort((x, y) => x - y);
  let max = 0, from = 0;
  sorted.forEach((t, i) => { while (sorted[from] <= t - windowMs) from++; max = Math.max(max, i - from + 1); });
  return max;
}

/**
 * Was the arm what it claims? A stays unprotected and never has a control. B and C begin and end
 * protected and open in one generation and epoch, with a ready control of the same Redis process in
 * every sample. All arms run with the feature on and on a Redis without persistence and eviction.
 */
export function admissionValidity(m, observations) {
  const queueArm = m.arm === 'b' || m.arm === 'c';
  const { before, after } = m.policy ?? {}, { before: first, after: last } = m.control ?? {};
  const same = (x, y) => !!x && !!y && x.generation === y.generation && x.epoch === y.epoch;
  const sampled = observations.map(o => o.queue?.control).filter(control => control !== undefined);
  const policy = queueArm
    ? before?.protected === true && after?.protected === true && before.phase === 'open' && after.phase === 'open' && same(before, after)
      && first?.mode === 'ready' && last?.mode === 'ready' && same(first, last) && same(before, first)
      && sampled.every(control => control?.mode === 'ready' && same(control, first))
    : before?.protected === false && after?.protected === false && first === null && last === null && sampled.every(control => control === null);
  const runId = m.redis?.before?.runId;
  const redisProcess = !!runId && runId === m.redis?.after?.runId && (!queueArm || (first?.runId === runId && last?.runId === runId && sampled.every(control => control?.runId === runId)));
  const required = { appendonly: 'no', save: '', 'maxmemory-policy': 'noeviction' };
  const redisConfig = [m.redis?.before?.config, m.redis?.after?.config].every(config => !!config && Object.entries(required).every(([key, value]) => config[key] === value));
  return { policy, redisProcess, redisConfig, environment: m.applicationEnvironment?.ENABLE_ADMISSION === 'true' };
}

const failedAttempt = p => p.data.tags.status === '0' || p.data.tags.status === '429' || Number(p.data.tags.status) >= 500;
const share = list => { const failures = list.filter(failedAttempt).length; return { attempts: list.length, failures, fraction: list.length ? failures / list.length : null }; };
const tally = (list, pick) => { const counts = new Map(); for (const item of list) counts.set(pick(item), (counts.get(pick(item)) ?? 0) + 1); return counts; };
const recorded = p => { try { return JSON.parse(p.data.metadata.e); } catch { return null; } };

async function analyzeV3(directory, m, read) {
  const s = m.settings, queueArm = m.arm === 'b' || m.arm === 'c';
  const metrics = new Set(['scenario_start_ms', 'buyers_started', 'buyers_completed', 'journey_outcomes', 'journey_duration', 'api_responses', 'api_duration', 'arrival_lag_ms',
    'active_vus_at_arrival', 'dropped_iterations', 'script_failures', 'protocol_failures', 'replay_failures', 'admission_trace', 'admission_journey']);
  const [points, sql, verification, observations, app, resources, cleanup, negatives, summary, dump, final] = await Promise.all([
    jsonLines(join(directory, 'k6-raw.jsonl'), p => p.type === 'Point' && metrics.has(p.metric)), read('sql-snapshot.json'), read('verification.json'),
    jsonLines(join(directory, 'observations.jsonl')), read('app-metrics.json'), jsonLines(join(directory, 'resources.jsonl')), read('cleanup.json'), read('negative-checks.json'), read('k6-summary.json'),
    read('redis-admission.json'), read('admission-final.json'),
  ]);
  const answers = points.filter(p => p.metric === 'api_responses');
  // The P2 figures are computed over purchase requests only, so polling cannot dilute an error share.
  const purchasePoints = points.filter(p => !['api_responses', 'api_duration'].includes(p.metric) || PURCHASE_STAGES.includes(p.data.tags.stage));
  const analysis = analyzePoints(purchasePoints, m, sql), w = analysis.window, a = analysis.all, c = analysis.cohort;
  // The same figures over the whole horizon: the arrival window plus the drain budget.
  const whole = analyzePoints(purchasePoints, { ...m, settings: { ...s, durationSeconds: s.durationSeconds + s.drainSeconds, measurementSeconds: s.measurementSeconds + s.drainSeconds } }, sql).window;
  const start = points.find(p => p.metric === 'scenario_start_ms').data.value;
  const left = Date.parse(w.start), horizonEnd = start + (s.durationSeconds + s.drainSeconds) * 1000;
  // Observation must cover the load as long as it ran: to the end of k6 or of the horizon.
  const loadEnd = Math.min(horizonEnd, epoch(m.loadEndedAt));
  const inLoad = row => inside(row.at ?? row.time, left, loadEnd);
  const observed = observations.filter(inLoad), pools = app.poolSamples.filter(inLoad), resourceWindow = resources.filter(inLoad);
  const queueSamples = observations.filter(o => o.queue);
  const clocks = m.clockChecks ?? [];
  const validity = admissionValidity(m, observations);
  const evidence = {
    sourceClean: m.workingTree === '',
    paidIdentityObserved: a.missingPaidIdentity === 0,
    checkoutAuditObserved: verification.integrityNames?.includes('checkoutPaymentIdentity') === true,
    accounting: metricAccounting(points, summary.metrics, s.users),
    observer: coverage(observations, left, loadEnd, 1000), 'queue-observer': coverage(queueSamples, left, loadEnd, 1000),
    // The application's 250 ms sampler stalls on an instance near its CPU limit: 2,000 ms, and the largest gap is published (v3.1).
    pool: coverage(app.poolSamples, left, loadEnd, 2000), resources: coverage(resources, left, loadEnd, 6000),
    clockAligned: clocks.length === 2 && clocks.every(o => Math.abs(o.offsetMs) + o.roundTripMs / 2 <= 100),
    generatorObserved: generatorObserved(resources, left, loadEnd, m.loadEndedAt),
    containersObserved: resourceWindow.length > 0 && resourceWindow.every(o => ['app', 'postgres', 'redis'].every(service => o.containers?.some(x => x.service === service && Number.isFinite(x.cpuPercent) && Number.isFinite(x.memoryPercent)))),
    clean: cleanup.passed === true && !m.cleanupError && !m.teardownError,
    // Three authentication refusals, and in a queue arm the refusal of a purchase without admission fields.
    auth: negatives.dataUnchanged === true && negatives.checks.length === (queueArm ? 4 : 3) && negatives.checks.every(o => o.status === o.expected && (o.expectedCode === undefined || o.code === o.expectedCode)),
    lifecycle: !m.evidenceErrors?.length && [0, 99].includes(m.k6ExitCode),
    'admission-evidence': Array.isArray(final.rows) && Array.isArray(final.ledger) && Array.isArray(dump.entries),
  };
  const hostPressure = resourceWindow.some((_, i) => i >= 2 && resourceWindow.slice(i - 2, i + 1).every(o => o.hostCpuPercent >= 90 || o.hostFreeBytes < 1073741824));

  // ---- the queue as Redis held it: samples describe it, every admittedAt is checked against R ----
  const entries = dump.entries ?? [], rate = m.profile?.rate;
  const offsetMs = stats(queueSamples.map(o => o.queue.redisTimeMs - o.queue.hostMidMs)).median; // Redis clock minus host clock
  const loadSamples = queueSamples.filter(o => inside(o.at, start, loadEnd));
  const held = (o, name) => Math.max(0, o.queue[name] - 1); // without the sentinel
  const admittedTimes = entries.map(e => e.admittedAt).filter(Number.isFinite);
  const maxPerSecond = rollingMax(admittedTimes);
  let backlogMs = 0, promotionsInBacklog = 0;
  loadSamples.forEach((o, i) => {
    const next = loadSamples[i + 1];
    if (!next || !held(o, 'waiting') || !held(next, 'waiting')) return;
    backlogMs += next.queue.redisTimeMs - o.queue.redisTimeMs;
    promotionsInBacklog += admittedTimes.filter(t => t >= o.queue.redisTimeMs && t < next.queue.redisTimeMs).length;
  });
  const queue = { rate, capacity: m.profile?.capacity, redisClockOffsetMs: offsetMs,
    samples: Object.fromEntries(['waiting', 'active', 'claims', 'window'].map(name => [name, stats(loadSamples.map(o => held(o, name)))])),
    maxPromotionsPerRollingSecond: maxPerSecond, rateHeld: Number.isFinite(rate) && maxPerSecond <= rate,
    // While two consecutive samples both saw somebody waiting: promotions against R times that time.
    backlogSeconds: backlogMs / 1000, promotionsInBacklog, promotionAchievement: backlogMs && rate ? promotionsInBacklog / (rate * backlogMs / 1000) : null };

  // ---- purchase writes ----
  const cohortBuyer = buyer => buyer >= s.warmupSeconds * s.rate && buyer < s.users;
  const buyerOf = p => Number(p.data.tags.buyer);
  const purchases = answers.filter(p => PURCHASE_STAGES.includes(p.data.tags.stage) && p.data.tags.kind !== 'replay');
  // The first request of a purchase: the reservation, or the checkout of a direct purchase. In a queue arm it consumes the admission.
  const firstRequests = purchases.filter(p => p.data.tags.stage === 'reservation' || (p.data.tags.stage === 'checkout' && p.data.tags.flow === 'direct'));
  const firstAttempts = firstRequests.filter(p => p.data.tags.kind === 'normal');
  const purchase = { stages: PURCHASE_STAGES, all: share(purchases),
    arrivalWindow: { attempts: w.nonReplayAttempts, failures: w.failureAttempts, fraction: w.failureFraction },
    horizon: { attempts: whole.nonReplayAttempts, failures: whole.failureAttempts, fraction: whole.failureFraction },
    measuredCohort: share(purchases.filter(p => cohortBuyer(buyerOf(p)))),
    http500InternalError: purchases.filter(p => p.data.tags.status === '500' && p.data.tags.code === 'INTERNAL_ERROR').length,
    http503: purchases.filter(p => p.data.tags.status === '503').length, unanswered: purchases.filter(p => p.data.tags.status === '0').length,
    conflicts: Object.fromEntries(tally(purchases.filter(p => p.data.tags.status === '409'), p => p.data.tags.code)),
    firstRequest: { firstAttempts: firstAttempts.length, firstAttemptFailures: firstAttempts.filter(failedAttempt).length,
      firstAttemptFailureFraction: firstAttempts.length ? firstAttempts.filter(failedAttempt).length / firstAttempts.length : null, repeats: firstRequests.length - firstAttempts.length } };
  const horizon = { start: w.start, endExclusive: new Date(horizonEnd).toISOString(), seconds: whole.seconds, confirmedPaid: whole.confirmedPaid, paidPerSecond: whole.paidPerSecond, warmupSpillover: whole.warmupSpillover };

  // ---- the queue as the buyers saw it: one summary and the controller's trace per buyer ----
  let admission = null, polling = null, recognition = null, trace = { complete: true, problems: 0, sample: [] };
  if (queueArm) {
    const problems = [], journeys = new Map();
    for (const p of points.filter(p => p.metric === 'admission_journey')) {
      const journey = recorded(p);
      if (!journey || journeys.has(buyerOf(p))) problems.push(`buyer ${buyerOf(p)}: ${journey ? 'two summaries' : 'unreadable summary'}`);
      else journeys.set(buyerOf(p), journey);
    }
    const events = points.filter(p => p.metric === 'admission_trace').map(p => ({ buyer: buyerOf(p), ...(recorded(p) ?? { type: 'unreadable' }) }));
    const statusAnswers = answers.filter(p => p.data.tags.stage === 'status'), joinAnswers = answers.filter(p => p.data.tags.stage === 'join');
    const tracesOf = tally(events, e => e.buyer), statusOf = tally(statusAnswers, buyerOf), joinsOf = tally(joinAnswers, buyerOf);
    const entryOf = new Map(entries.map(e => [e.userId, e]));
    if (events.some(e => e.type === 'unreadable')) problems.push('unreadable trace events');
    for (let buyer = 0; buyer < s.users; buyer++) {
      const journey = journeys.get(buyer), entry = entryOf.get(m.fixture.userIds[buyer]);
      if (!journey) { problems.push(`buyer ${buyer}: no summary`); continue; }
      if (journey.traceEvents !== (tracesOf.get(buyer) ?? 0)) problems.push(`buyer ${buyer}: ${tracesOf.get(buyer) ?? 0} of ${journey.traceEvents} trace events`);
      if (journey.requests?.status !== (statusOf.get(buyer) ?? 0) || journey.requests?.join !== (joinsOf.get(buyer) ?? 0)) problems.push(`buyer ${buyer}: request counts differ from the summary`);
      if (journey.joinKey !== m.fixture.joinKeys?.[buyer]) problems.push(`buyer ${buyer}: another join key`);
      // A recognition is a sample only with both bounds and its instant (v3.2).
      if (journey.recognition && ![journey.recognition.lowerMs, journey.recognition.upperMs, journey.recognition.at].every(Number.isFinite)) problems.push(`buyer ${buyer}: a recognition without its delays`);
      // An entry the buyer saw is the one Redis keeps for that user and that join key.
      if (journey.admissionId && !(entry?.admissionId === journey.admissionId && dump.joins?.[journey.joinKey] === journey.admissionId)) problems.push(`buyer ${buyer}: entry or join mapping differs`);
    }
    trace = { complete: problems.length === 0, problems: problems.length, sample: problems.slice(0, 5) };

    // Promoted before the buyers' cutoff, on the Redis clock. A promotion after it had nobody left to see it.
    const cutoff = start + s.cutoffSeconds * 1000 + (offsetMs ?? 0);
    const promoted = entries.filter(e => Number.isFinite(e.admittedAt) && e.admittedAt <= cutoff);
    const buyerIndex = new Map(m.fixture.userIds.map((id, i) => [id, i]));
    const all = [...journeys], recognized = all.filter(([, j]) => j.recognition), missed = all.filter(([, j]) => !j.recognition && j.missed);
    const seen = new Set([...recognized, ...missed].map(([buyer]) => buyer));
    const paidAfter = recognized.filter(([, j]) => j.outcome === 'paid'), bought = recognized.filter(([, j]) => j.purchase);
    // An upper bound of admittedAt → purchase answer, on the generator's clock alone.
    const occupation = bought.map(([, j]) => j.recognition.upperMs + (j.purchase.lastRecvAt - j.recognition.at));
    // Entries promoted before the cutoff that Redis kept as expired, whatever outcome their buyer was left with (v3.2).
    const expired = promoted.filter(e => e.state === 'expired').map(e => journeys.get(buyerIndex.get(e.userId)));
    admission = { registered: new Set(entries.map(e => e.userId)).size, promoted: promoted.length,
      promotedAfterCutoff: entries.filter(e => Number.isFinite(e.admittedAt) && e.admittedAt > cutoff).length,
      recognized: recognized.length, missed: missed.length, unrecognized: promoted.filter(e => !seen.has(buyerIndex.get(e.userId))).length,
      queueWaitMs: stats(promoted.map(e => e.admittedAt - e.joinedAt)),
      recognitionToPaidMs: stats(paidAfter.map(([, j]) => j.endedAt - j.recognition.at)),
      measuredRecognitionToPaidMs: stats(paidAfter.filter(([buyer]) => cohortBuyer(buyer)).map(([, j]) => j.endedAt - j.recognition.at)),
      admittedToPurchaseAnswerMs: stats(occupation), slotOccupationSeconds: occupation.length ? occupation.reduce((sum, ms) => sum + ms, 0) / occupation.length / 1000 : null,
      foregroundExpired: all.filter(([, j]) => j.outcome === 'admission_expired' && !j.hidden).length,
      expiredEntries: { foreground: expired.filter(j => !j?.hidden).length, hidden: expired.filter(j => j?.hidden).length, byOutcome: Object.fromEntries(tally(expired, j => j?.outcome ?? 'no summary')) },
      entryStates: Object.fromEntries(tally(entries, e => `${e.state}/${e.phase}`)) };
    const layer = name => { const list = recognized.map(([, j]) => j.recognition).filter(r => !name || r.layer === name);
      return { count: list.length, lowerMs: stats(list.map(r => r.lowerMs)), upperMs: stats(list.map(r => r.upperMs)) }; };
    recognition = { measuredBy: 'the controller in the generator; not a browser', promoted: admission.promoted, unrecognized: admission.unrecognized, missed: admission.missed,
      all: layer(), foreground: layer('foreground'), hidden: layer('hidden'), reconnect: layer('reconnect') };
    // admission-v1 §7: foreground p95 within 2 s, a goal that can be refuted.
    recognition.withinTwoSeconds = recognition.foreground.upperMs.p95 !== null && recognition.foreground.upperMs.p95 <= 2000;
    const polls = events.filter(e => e.type === 'poll'), timed = polls.filter(e => e.reason === 'timer' && Number.isFinite(e.plannedDelayMs) && Number.isFinite(e.actualDelayMs));
    const registered = all.filter(([, j]) => j.admissionId);
    polling = { statusRequests: statusAnswers.length, joinRequests: joinAnswers.length, registeredUsers: registered.length,
      perRegisteredUser: stats(registered.map(([, j]) => j.requests.status)),
      // Per second with at least one status request, by the second of its answer.
      perSecond: stats([...tally(statusAnswers, p => Math.floor(epoch(p.data.time) / 1000)).values()]),
      byReason: Object.fromEntries(tally(polls, e => e.reason)), outsideCadence: polls.filter(e => e.reason !== 'timer').length,
      plannedDelayMs: stats(timed.map(e => e.plannedDelayMs)), actualDelayMs: stats(timed.map(e => e.actualDelayMs)), lateMs: stats(timed.map(e => e.actualDelayMs - e.plannedDelayMs)),
      aborted: events.filter(e => e.type === 'poll-aborted').length, timedOut: polls.filter(e => e.timedOut).length, failures: statusAnswers.filter(failedAttempt).length };
  }

  const invalidReasons = [];
  for (const [name, value] of Object.entries(evidence)) if (!(typeof value === 'object' ? value.complete : value)) invalidReasons.push(name);
  if (a.dropped || a.started !== a.offered || a.duplicateStarts || a.duplicateCompletions) invalidReasons.push('arrival-delivery');
  if (a.arrivalLagMs.max === null || a.arrivalLagMs.max > 250) invalidReasons.push('arrival-lag');
  if (a.scriptFailures || a.protocolFailures) invalidReasons.push('script/protocol');
  if (hostPressure) invalidReasons.push('host-pressure');
  if (answers.some(p => ['401', '403'].includes(p.data.tags.status) || (p.data.tags.status === '429' && PURCHASE_STAGES.includes(p.data.tags.stage)))) invalidReasons.push('auth-or-limiter');
  if (answers.some(p => (p.data.tags.status === '429' && QUEUE_STAGES.includes(p.data.tags.stage)) || ['ADMISSION_QUEUE_FULL', 'ADMISSION_RATE_LIMITED'].includes(p.data.tags.code))) invalidReasons.push('admission-limiter');
  if (!validity.policy || !validity.environment) invalidReasons.push('policy');
  if (!validity.redisProcess) invalidReasons.push('redis-restart');
  if (!validity.redisConfig) invalidReasons.push('redis-config');
  if (!trace.complete) invalidReasons.push('trace');
  // A verification run proves its bounds only with a whole capture: begun on an empty admission keyspace, ended by the fixture (v3.3).
  if (s.monitor && !(m.monitor && m.monitor.keysAtStart === 0 && m.monitor.endedEarly === false)) invalidReasons.push('monitor-capture');

  const stable = a.replayFailures === 0 && c.completionFraction >= .99 && w.failureFraction !== null && w.failureFraction <= .01 && c.paidJourneyMs.p99 !== null && c.paidJourneyMs.p99 <= 2000
    && Math.abs(w.firstHalfPaidPerSecond - w.secondHalfPaidPerSecond) / s.rate <= .2;
  // Integrity: the P2 SQL checks, any row of admission-final.sql, a ledger mismatch, a paid answer SQL
  // does not have, or more promotions in a rolling second than R. Unread evidence is invalid, not a defect.
  const sqlChecks = (verification.integrityNames ?? []).filter(name => !['admissionFinalSql', 'admissionLedger'].includes(name));
  const integrity = Array.isArray(verification.integrityNames) && sqlChecks.every(name => verification.checks?.[name] === true)
    && a.httpPaidWithoutSql === 0 && a.httpPaidIdentityMismatches === 0
    && !(Array.isArray(final.rows) && final.rows.length) && !(Array.isArray(final.ledger) && final.ledger.length) && queue.rateHeld;
  const classification = !integrity ? 'integrity-defect' : invalidReasons.length ? 'invalid-measurement'
    : s.monitor ? 'valid-verification' : queueArm ? 'valid-queue' : classify({ integrity, valid: true, stable, stock: s.stock });
  const logs = app.admissionLogs ?? [];
  return { revision: m.revision, analysisRevision: ANALYSIS_REVISION, runId: m.runId, arm: m.arm, pollMode: m.pollMode ?? null, profile: m.profile ?? null, classification,
    smokePassed: m.smokePassed ?? m.passed, k6ExitCode: m.k6ExitCode, invalidReasons, validity,
    // Product behaviour that is published with a run and does not make it invalid.
    disclosures: { quiesce: m.quiesce ?? null, applicationStop: m.applicationStop ?? null, monitor: m.monitor ?? null, readyAfterMs: m.readyAfterMs ?? null, poolMaxGapMs: evidence.pool.maxGapMs },
    // The numbers the pilot rules read. Thresholds are fixed in the protocol, not here.
    criteria: { completionFraction: c.completionFraction, purchaseFailureFraction: purchase.measuredCohort.fraction,
      paidP99AfterAdmissionMs: queueArm ? admission.measuredRecognitionToPaidMs.p99 : c.paidJourneyMs.p99, promotionAchievement: queue.promotionAchievement,
      finalSqlRows: Array.isArray(final.rows) ? final.rows.length : null, ledgerMismatches: Array.isArray(final.ledger) ? final.ledger.length : null, stableByP2: queueArm ? null : stable },
    evidence, ...analysis, horizon, purchase, admission, recognition, polling, queue, trace,
    applicationLogs: Object.fromEntries(['transientPurchase', 'finalizationLeft', 'notReclaimed', 'iterationFailed'].map(kind => [kind, logs.filter(line => line.kind === kind).length])),
    diagnostics: { window: 'from the measurement start to the end of the load', poolWaiting: stats(pools.map(o => o.waiting)), poolCheckedOut: stats(pools.map(o => o.checkedOut)),
      lockWaiters: stats(observed.map(o => o.activity?.lock_waiters)), lockTypes: [...new Set(observed.flatMap(o => o.locks?.map(l => l.locktype) ?? []))],
      redisObserverRttMs: stats(observed.map(o => o.redisPingRttMs)), retriesScheduledInWindow: app.retrySamples.filter(inLoad).length,
      hostCpuPercent: stats(resourceWindow.map(o => o.hostCpuPercent)), hostFreeBytes: stats(resourceWindow.map(o => o.hostFreeBytes)),
      containers: Object.fromEntries(['app', 'postgres', 'redis'].map(service => [service, {
        cpuPercent: stats(resourceWindow.map(o => o.containers?.find(x => x.service === service)?.cpuPercent)),
        memoryPercent: stats(resourceWindow.map(o => o.containers?.find(x => x.service === service)?.memoryPercent)),
      }])), generatorCpuSeconds: stats(resourceWindow.map(o => o.generator?.cpuSeconds)), generatorMemoryBytes: stats(resourceWindow.map(o => o.generator?.memoryBytes)) },
    sqlCounts: verification.counts, failedSmokeChecks: Object.entries(verification.checks).filter(([, v]) => !v).map(([k]) => k) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  analyzeRun(resolve(process.argv[2])).then(value => console.log(JSON.stringify(value, null, 2))).catch(err => { console.error(err.message); process.exitCode = 1; });
}
