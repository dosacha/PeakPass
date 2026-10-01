// Offline analysis of preserved evidence; never changes the original run.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const ANALYSIS_REVISION = 'flash-sale-analysis-v2.3.1';

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

export function metricAccounting(points, summary) {
  const select = metric => points.filter(p => p.metric === metric);
  const sum = metric => select(metric).reduce((n, p) => n + p.data.value, 0);
  const key = p => Object.entries(p.data.tags).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('/');
  const bag = metric => { const b = {}; for (const p of select(metric)) b[key(p)] = (b[key(p)] ?? 0) + 1; return Object.entries(b).sort().map(JSON.stringify).join('\n'); };
  const checks = {
    attempts: bag('api_responses') === bag('api_duration') && sum('api_responses') === (summary.http_reqs?.count ?? 0),
    journeys: bag('journey_outcomes') === bag('journey_duration') && select('journey_outcomes').length === (summary.iterations?.count ?? 0),
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
  const paidUsers = new Set(sql.orders.filter(o => o.status === 'paid').map(o => o.user_id));
  const starts = select('buyers_started'), completions = select('buyers_completed');
  const confirmed = completions.filter(p => paidUsers.has(manifest.fixture.userIds[buyer(p)]));
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
      httpPaidWithoutSql: completions.length - confirmed.length, duplicateStarts: starts.length - unique(starts), duplicateCompletions: completions.length - unique(completions),
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
    accounting: metricAccounting(points, summary.metrics),
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
  const integrity = verification.integrityPassed && a.httpPaidWithoutSql === 0;
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  analyzeRun(resolve(process.argv[2])).then(value => console.log(JSON.stringify(value, null, 2))).catch(err => { console.error(err.message); process.exitCode = 1; });
}
