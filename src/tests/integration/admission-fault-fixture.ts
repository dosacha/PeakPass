import { execFile } from 'child_process';
import { promisify } from 'util';
import { connect, createServer, Socket } from 'net';
import { request as httpRequest } from 'http';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import jwt from 'jsonwebtoken';
import { Pool, PoolClient } from 'pg';
import { createClient } from 'redis';
import { readAdmissionPolicy } from '@/infra/postgres/admission-policy';
import type { Json } from './admission-purchase-fixture';
import {
  MonitorEntry,
  parseMonitorLine,
  replayAdmissionLog,
} from '../helpers/admission-transition-log';

/**
 * Real failures at the integration boundary (admission-v1 §8, P7).
 *
 * The product runs as containers of the production image named by ADMISSION_FAULT_IMAGE, next to
 * a PostgreSQL and a Redis that this fixture creates and removes. Faults are real: `docker pause`,
 * `stop`, `start` and `kill` of those containers. Three things here are synthetic stimuli and are
 * named as such wherever they are used: users and tokens made by SQL and a local secret, the event
 * gate held by the test session, and a `pg_sleep` trigger on one marked request.
 */
export const faultImage = process.env.ADMISSION_FAULT_IMAGE;
export const faultSuite = faultImage ? describe : describe.skip;
export const TIER = 'general';
const TASK = process.env.ADMISSION_FAULT_TASK || 'admission-fault';
const EVIDENCE = process.env.ADMISSION_FAULT_EVIDENCE;
const run = promisify(execFile);

export type { Json };
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function until<T>(
  check: () => Promise<T | false | null | undefined> | T | false | null | undefined,
  timeoutMs = 20000,
  what = 'condition',
  intervalMs = 100,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= end) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

export interface Answer {
  status: number;
  code: string | null;
  body: Json | null;
  app: number;
  ms: number;
}
export interface AppBox {
  index: number;
  id: string;
  name: string;
  url: string;
  admission: boolean;
}
export interface AdmissionRef {
  admissionId: string;
  admissionEpoch: string;
}

/**
 * The transition log: MONITOR on a raw socket. `KEYS` and `MONITOR` travel in one write, and Redis
 * runs the commands of one read back to back, so a capture that saw no admission key holds every
 * later write. A capture that began with keys present is marked incomplete.
 */
class Monitor {
  readonly entries: MonitorEntry[] = [];
  /** The kept lines as Redis sent them, for the evidence archive. */
  readonly lines: string[] = [];
  incomplete: string[] = [];
  private socket: Socket | null = null;
  constructor(private port: number) {}

  /** `restarted`: the server process was replaced, so everything the log knew is gone. */
  async attach(restarted = false): Promise<void> {
    const keys = await until(() => this.open(), 30000, 'the Redis MONITOR connection', 20);
    if (keys.length)
      this.incomplete.push(`capture began with ${keys.length} admission keys present`);
    else if (restarted)
      this.entries.push({ time: Date.now(), source: 'fixture:restart', args: ['FLUSHALL'] });
  }
  /** The admission keys present when MONITOR began, or null when the server did not answer. */
  private open(): Promise<string[] | null> {
    return new Promise((resolve) => {
      const socket = connect(this.port, '127.0.0.1');
      let text = '';
      let streaming = false;
      const fail = () => {
        if (streaming) return;
        socket.destroy();
        resolve(null);
      };
      socket.setEncoding('latin1');
      socket.on('error', fail);
      socket.on('close', fail);
      socket.once('connect', () =>
        socket.write('*2\r\n$4\r\nKEYS\r\n$20\r\npeakpass:admission:*\r\n*1\r\n$7\r\nMONITOR\r\n'),
      );
      socket.on('data', (chunk: string) => {
        text += chunk;
        if (streaming) {
          text = this.take(text);
          return;
        }
        if (text.startsWith('-')) return fail();
        const head = /^\*(\d+)\r\n/.exec(text);
        if (!head) return;
        const count = Number(head[1]);
        const lines = text.split('\r\n');
        // *N, N pairs of ($len, key), +OK, and whatever of the stream has arrived already.
        if (lines.length < 1 + count * 2 + 2) return;
        if (lines[1 + count * 2] !== '+OK') return fail();
        streaming = true;
        this.socket = socket;
        text = this.take(lines.slice(2 + count * 2).join('\r\n'));
        resolve(Array.from({ length: count }, (_, i) => lines[2 + i * 2]));
      });
    });
  }
  /** Keeps the admission writes of the complete lines in `text` and returns the unfinished tail. */
  private take(text: string): string {
    let from = 0;
    for (let end = text.indexOf('\r\n', from); end >= 0; end = text.indexOf('\r\n', from)) {
      const line = text.slice(from + 1, end);
      from = end + 2;
      const at = line.indexOf('] "');
      if (at < 0) continue;
      // A script body is long and never a write of its own: only the command name is read here.
      const command = line.slice(at + 3, line.indexOf('"', at + 3)).toUpperCase();
      const wanted =
        command === 'FLUSHALL' ||
        command === 'FLUSHDB' ||
        ((command === 'ZADD' || command === 'ZREM' || command === 'UNLINK' || command === 'DEL') &&
          line.includes('peakpass:admission:')) ||
        (command === 'HSET' && line.includes(':control"'));
      if (!wanted) continue;
      const entry = parseMonitorLine(line);
      if (!entry) continue;
      this.lines.push(line);
      this.entries.push(entry);
    }
    return text.slice(from);
  }
  detach() {
    this.socket?.destroy();
    this.socket = null;
  }
}

export type Topology = Awaited<ReturnType<typeof startTopology>>;

export async function startTopology(
  options: {
    /** One entry per application container; `admission` is its ENABLE_ADMISSION. */
    apps?: Array<{ admission: boolean; env?: Record<string, string> }>;
    env?: Record<string, string>;
  } = {},
) {
  if (!faultImage) throw new Error('ADMISSION_FAULT_IMAGE is required');
  const image = faultImage;
  const prefix = `pp-fault-${randomBytes(4).toString('hex')}`;
  const labels = ['--label', `peakpass.task=${TASK}`, '--label', `peakpass.fault-run=${prefix}`];
  const secrets = {
    DB_PASSWORD: randomBytes(18).toString('base64url'),
    JWT_SECRET: randomBytes(36).toString('base64url'),
    API_KEY: randomBytes(24).toString('base64url'),
    WEBHOOK_SIGNING_SECRET: randomBytes(24).toString('base64url'),
  };
  const appEnv: Record<string, string> = {
    NODE_ENV: 'production',
    PORT: '3000',
    LOG_LEVEL: 'info',
    DB_HOST: 'pg',
    DB_PORT: '5432',
    DB_USER: 'peakpass',
    DB_NAME: 'peakpass',
    REDIS_HOST: 'redis',
    REDIS_PORT: '6379',
    ENFORCE_AUTH_USER_MATCH: 'true',
    ENABLE_RATE_LIMITING: 'true',
    RATE_LIMIT_FAIL_MODE: 'closed',
    // Every buyer is another user; the purchase limit itself is not what these suites look at.
    RATE_LIMIT_MAX_REQUESTS: '100000',
    ...secrets,
    ...options.env,
  };
  // Values reach the containers through the environment of the docker CLI, never its arguments.
  const cliEnv = { ...process.env, ...appEnv, POSTGRES_PASSWORD: secrets.DB_PASSWORD };
  const docker = async (...args: string[]) =>
    (
      await run('docker', args, {
        env: cliEnv,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 256 * 1024 * 1024,
      })
    ).stdout.trim();
  const created: string[] = [];
  const names = new Map<string, string>();
  const started = Date.now();
  const notes: Json[] = [];
  const requests: Json[] = [];
  const note = (what: string, data: Json = {}) => {
    const record = { at: Date.now() - started, what, ...data };
    notes.push(record);
    process.stdout.write(JSON.stringify(record) + '\n');
  };

  await docker('network', 'create', ...labels, prefix);
  const pgPort = await freePort();
  const pgId = await docker('run', '-d', '--name', `${prefix}-pg`, '--network', prefix,
    '--network-alias', 'pg', ...labels, '-e', 'POSTGRES_USER=peakpass', '-e', 'POSTGRES_PASSWORD',
    '-e', 'POSTGRES_DB=peakpass', '-p', `127.0.0.1:${pgPort}:5432`, 'postgres:16-alpine',
    '-c', 'track_commit_timestamp=on');
  created.push(pgId);
  names.set(pgId, 'pg');
  const redisPort = await freePort();
  const redisId = await docker('run', '-d', '--name', `${prefix}-redis`, '--network', prefix,
    '--network-alias', 'redis', ...labels, '-p', `127.0.0.1:${redisPort}:6379`, 'redis:7-alpine',
    'redis-server', '--save', '', '--appendonly', 'no', '--maxmemory', '256mb',
    '--maxmemory-policy', 'noeviction');
  created.push(redisId);
  names.set(redisId, 'redis');

  const newPool = () => {
    const made = new Pool({ host: '127.0.0.1', port: pgPort, user: 'peakpass',
      password: secrets.DB_PASSWORD, database: 'peakpass', max: 20 });
    made.on('error', () => undefined);
    made.on('connect', (client) => client.on('error', () => undefined));
    return made;
  };
  let pool = newPool();
  // The image's first boot restarts the server once; three answers in a row mean it is up for good.
  let answers = 0;
  await until(async () => {
    try {
      await pool.query('SELECT 1');
      return ++answers >= 3;
    } catch {
      answers = 0;
      return false;
    }
  }, 60000, 'PostgreSQL', 300);
  const monitor = new Monitor(redisPort);
  await monitor.attach();
  const newRedis = async () => {
    const client = createClient({ socket: { host: '127.0.0.1', port: redisPort, reconnectStrategy: false } });
    client.on('error', () => undefined);
    await client.connect();
    return client;
  };
  let redis = await newRedis();

  const containerEnv = (extra: Record<string, string>) =>
    Object.entries({ ...appEnv, ...extra }).flatMap(([name, value]) =>
      name in extra ? ['--env', `${name}=${value}`] : ['--env', name],
    );
  note('migrations', {
    out: (await docker('run', '--rm', '--network', prefix, ...labels, ...containerEnv({}), image,
      'node', 'dist/infra/migrations/runner.js', 'up')).split('\n').slice(-2).join(' '),
  });

  const apps: AppBox[] = [];
  const ready = async (app: AppBox, timeoutMs = 60000) =>
    until(async () => {
      try {
        const response = await fetch(`${app.url}/ready`, { signal: AbortSignal.timeout(2000) });
        await response.arrayBuffer();
        return response.status === 200;
      } catch {
        return false;
      }
    }, timeoutMs, `${app.name} to be ready`, 250);
  for (const [index, spec] of (options.apps ?? [{ admission: true }, { admission: true }]).entries()) {
    const port = await freePort();
    const name = `${prefix}-app${index + 1}`;
    const id = await docker('run', '-d', '--name', name, '--network', prefix, ...labels,
      '-p', `127.0.0.1:${port}:3000`,
      ...containerEnv({ ENABLE_ADMISSION: String(spec.admission), ...spec.env }), image);
    created.push(id);
    names.set(id, `app${index + 1}`);
    apps.push({ index, id, name, url: `http://127.0.0.1:${port}`, admission: spec.admission });
  }
  await Promise.all(apps.map((app) => ready(app)));
  const enabled = () => apps.filter((app) => app.admission);

  async function http(
    app: AppBox,
    method: string,
    path: string,
    request: {
      token?: string;
      body?: unknown;
      key?: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      user?: string;
      /** A client that closes its connection after the answer instead of keeping it alive. */
      closing?: boolean;
    } = {},
  ): Promise<Answer> {
    const began = performance.now();
    let status = 0;
    let body: Json | null = null;
    if (request.closing) {
      const answer = await closingRequest(app, method, path, request);
      requests.push({ at: Date.now() - started, user: request.user ?? null, app: answer.app, method,
        path, status: answer.status, code: answer.code, ms: answer.ms, closing: true });
      return answer;
    }
    try {
      const response = await fetch(app.url + path, {
        method,
        headers: {
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(request.token ? { authorization: `Bearer ${request.token}` } : {}),
          ...(request.key ? { 'idempotency-key': request.key } : {}),
          ...request.headers,
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(request.timeoutMs ?? 10000),
      });
      const text = await response.text();
      status = response.status;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { raw: text.slice(0, 200) };
      }
    } catch {
      status = 0; // no answer: refused, reset, or the timeout above
    }
    const answer: Answer = {
      status,
      code: body?.error?.code ?? (typeof body?.error === 'string' ? body.error : null),
      body,
      app: app.index + 1,
      ms: Math.round(performance.now() - began),
    };
    requests.push({ at: Date.now() - started, user: request.user ?? null, app: answer.app, method,
      path, status, code: answer.code, ms: answer.ms });
    return answer;
  }

  /** One request on a connection of its own that is closed after the answer (`Connection: close`). */
  function closingRequest(
    app: AppBox,
    method: string,
    path: string,
    request: { token?: string; body?: unknown; key?: string; timeoutMs?: number },
  ): Promise<Answer> {
    const began = performance.now();
    return new Promise((resolve) => {
      const done = (status: number, text = '') => {
        let body: Json | null = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = { raw: text.slice(0, 200) };
        }
        resolve({ status, code: body?.error?.code ?? null, body, app: app.index + 1, ms: Math.round(performance.now() - began) });
      };
      const outgoing = httpRequest(
        app.url + path,
        {
          method,
          agent: false,
          timeout: request.timeoutMs ?? 10000,
          headers: {
            connection: 'close',
            ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(request.token ? { authorization: `Bearer ${request.token}` } : {}),
            ...(request.key ? { 'idempotency-key': request.key } : {}),
          },
        },
        (incoming) => {
          let text = '';
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk) => (text += chunk));
          incoming.on('end', () => done(incoming.statusCode ?? 0, text));
        },
      );
      outgoing.on('timeout', () => outgoing.destroy());
      outgoing.on('error', () => done(0));
      outgoing.end(request.body === undefined ? undefined : JSON.stringify(request.body));
    });
  }

  /** One logical request, repeated with the same identity while its outcome is unknown. */
  async function decided(
    send: (attempt: number) => Promise<Answer>,
    deadlineMs = 60000,
  ): Promise<{ final: Answer; attempts: Answer[] }> {
    const attempts: Answer[] = [];
    const end = Date.now() + deadlineMs;
    for (let attempt = 0; ; attempt++) {
      const answer = await send(attempt);
      attempts.push(answer);
      const unknown =
        answer.status === 0 ||
        answer.status === 429 ||
        answer.status >= 500 ||
        (answer.status === 409 && answer.code === 'ADMISSION_IN_PROGRESS');
      if (!unknown || Date.now() >= end) return { final: answer, attempts };
      await sleep(Math.max(Number(answer.body?.nextPollAfterMs) || 0, Math.min(250 * 2 ** attempt, 2000)));
    }
  }

  /** Synthetic: a user row made by SQL and a token signed with this run's secret. */
  async function buyer() {
    const userId = randomUUID();
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [userId, `${userId}@p7.test`]);
    const token = jwt.sign({ sub: userId }, secrets.JWT_SECRET, { expiresIn: '1h' });
    const call = (app: AppBox, method: string, path: string, body?: unknown, key?: string, timeoutMs?: number) =>
      http(app, method, path, { token, body, key, timeoutMs, user: userId });
    const self = {
      userId,
      token,
      call,
      status: (eventId: string, app = enabled()[0]) => call(app, 'GET', `/events/${eventId}/admissions/me`),
      join: (eventId: string, epoch: string, joinRequestId: string = randomUUID(), app = enabled()[0]) =>
        call(app, 'POST', `/events/${eventId}/admissions`, { epoch, joinRequestId }),
      cancel: (eventId: string, admission: AdmissionRef, app = enabled()[0]) =>
        call(app, 'DELETE', `/events/${eventId}/admissions/${admission.admissionId}`, {
          epoch: admission.admissionEpoch,
        }),
      /** Joins and returns the entry while it is still waiting. */
      async queue(eventId: string, app = enabled()[0], joinRequestId: string = randomUUID()) {
        const first = await until(async () => {
          const answer = await self.status(eventId, app);
          return answer.status === 200 && answer;
        }, 30000, 'the queue to answer', 500);
        const admissionEpoch: string = first.body!.queue.epoch;
        const joined = await decided(() => self.join(eventId, admissionEpoch, joinRequestId, app), 30000);
        if (joined.final.status !== 201 && joined.final.status !== 200)
          throw new Error(`join answered ${joined.final.status} ${joined.final.code}`);
        return { admissionId: joined.final.body!.admission.admissionId as string, admissionEpoch };
      },
      /** Polls once a second until the entry is admitted. */
      async admitted(eventId: string, timeoutMs = 60000, app = enabled()[0]) {
        await until(async () => {
          const answer = await self.status(eventId, app);
          const state = answer.body?.admission?.state;
          if (answer.status === 200 && state && state !== 'waiting' && state !== 'admitted')
            throw new Error(`entry ended as ${state} before admission`);
          return answer.status === 200 && state === 'admitted';
        }, timeoutMs, 'admission', 1000);
      },
      async enter(eventId: string, timeoutMs = 60000, app = enabled()[0]): Promise<AdmissionRef> {
        const admission = await self.queue(eventId, app);
        await self.admitted(eventId, timeoutMs, app);
        return admission;
      },
      /** The body of a new reservation; send it again unchanged to repeat the request. */
      reservationBody: (eventId: string, admission: AdmissionRef | null, quantity = 1) => ({
        eventId,
        userId,
        quantity,
        tierId: TIER,
        ...(admission ?? {}),
      }),
      reserve: (
        eventId: string,
        admission: AdmissionRef | null,
        quantity = 1,
        targets = enabled(),
        deadlineMs?: number,
      ) => {
        const body = self.reservationBody(eventId, admission, quantity);
        return decided((n) => call(targets[n % targets.length], 'POST', '/reservations', body), deadlineMs);
      },
      /** A checkout: with `reservationId` an existing reservation, otherwise a direct purchase. */
      checkout: (
        eventId: string,
        input: { admission?: AdmissionRef | null; reservationId?: string; quantity?: number; key?: string },
        targets = enabled(),
        deadlineMs?: number,
      ) => {
        const key = input.key ?? randomUUID();
        const body = {
          eventId,
          userId,
          quantity: input.quantity ?? 1,
          tierId: TIER,
          ...(input.reservationId ? { reservationId: input.reservationId } : {}),
          ...(input.admission ?? {}),
        };
        return decided((n) => call(targets[n % targets.length], 'POST', '/checkouts', body, key), deadlineMs);
      },
    };
    return self;
  }

  /** A provider callback with its HMAC signature, as the payment provider sends it. */
  function settle(
    app: AppBox,
    orderId: string,
    status: 'settled' | 'failed' = 'settled',
    key: string = randomUUID(),
    provider = `p7-${randomUUID()}`,
  ) {
    const payload = { orderId, providerTransactionId: provider, status };
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secrets.WEBHOOK_SIGNING_SECRET)
      .update(`${timestamp}.${JSON.stringify(payload)}`)
      .digest('hex');
    return http(app, 'POST', '/webhooks/payments/settlement', {
      body: payload,
      key,
      headers: { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': signature },
    });
  }

  const control = async (eventId: string) => {
    const found = await redis.hGetAll(`peakpass:admission:${eventId}:control`);
    return Object.keys(found).length
      ? (found as { generation: string; epoch: string; mode: string; runId: string })
      : null;
  };
  const policy = async (eventId: string) =>
    (
      await pool.query<{ protected: boolean; generation: string; epoch: string; phase: string }>(
        'SELECT protected, generation::text, epoch::text, phase FROM admission_events WHERE event_id=$1',
        [eventId],
      )
    ).rows[0] ?? null;

  /** The contract's explicit transition: exclusive event gate, real UPDATE. Returns its commit time. */
  async function protect(eventId: string, value: boolean, holdMs = 0): Promise<Date> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await readAdmissionPolicy(client, eventId, 'exclusive');
      await client.query('UPDATE admission_events SET protected=$2 WHERE event_id=$1', [eventId, value]);
      const xid = (await client.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid;
      if (holdMs) await sleep(holdMs);
      await client.query('COMMIT');
      return (await client.query('SELECT pg_xact_commit_timestamp($1::xid) AS at', [xid])).rows[0].at;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  /** A published event with one tier; protected unless told otherwise, and then waited for. */
  async function event(seats = 20, isProtected = true): Promise<string> {
    const eventId = randomUUID();
    await pool.query(
      `INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats,pricing,status)
      VALUES($1,'p7 fault',NOW()+interval '1 hour',NOW()+interval '2 hours',$2,$2,$3,'published')`,
      [eventId, seats, JSON.stringify([{ id: TIER, name: 'General', price: 50, quantity: seats }])],
    );
    if (isProtected) {
      await protect(eventId, true);
      await until(async () => (await control(eventId))?.mode === 'ready', 30000, 'the namespace to be published');
    }
    return eventId;
  }

  /**
   * Synthetic stimulus: the shared event gate and the policy share lock of a consumer, held by
   * this session. `granted` resolves once PostgreSQL grants them, which may be after a wait.
   */
  function holdGate(eventId: string) {
    let client: PoolClient | null = null;
    const granted = (async () => {
      client = await pool.connect();
      await client.query('BEGIN');
      await readAdmissionPolicy(client, eventId, 'shared');
    })();
    granted.catch(() => undefined);
    return {
      granted,
      async release() {
        await granted.catch(() => undefined);
        if (!client) return;
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
        client = null;
      },
    };
  }
  /**
   * Synthetic stimulus: one user's INSERT into `table` sleeps for `seconds` inside PostgreSQL.
   * Returns the removal. The timers that fire because of it are PostgreSQL's own.
   */
  let triggers = 0;
  async function slow(table: 'reservations' | 'orders' | 'admission_results', userId: string, seconds: number) {
    const name = `p7_slow_${++triggers}`;
    await pool.query(`CREATE OR REPLACE FUNCTION p7_sleep() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN PERFORM pg_sleep(TG_ARGV[0]::float8); RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW
      WHEN (NEW.user_id = '${userId}'::uuid) EXECUTE FUNCTION p7_sleep('${seconds}')`);
    return () => pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
  }
  /** Waits until PostgreSQL shows a statement like `queryLike` sleeping in the trigger of `slow`. */
  const sleeping = (queryLike: string) =>
    until(
      async () => (await backends(queryLike)).some((backend) => backend.wait_event === 'PgSleep'),
      15000,
      `a statement like ${queryLike} to be held`,
      50,
    );
  /** The server log of PostgreSQL, where its own timers report what they ended. */
  const pgLog = async () => {
    const { stdout, stderr } = await run('docker', ['logs', pgId], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout + stderr;
  };
  /** Redis server time in milliseconds: the clock of every admission deadline. */
  const redisNow = async () => {
    const [seconds, micros] = (await redis.sendCommand(['TIME'])) as [string, string];
    return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
  };
  /** Backends whose current statement matches, as PostgreSQL reports them. */
  const backends = async (queryLike: string) =>
    (
      await pool.query<{ pid: number; state: string; wait_event: string | null; client_addr: string | null }>(
        `SELECT pid, state, wait_event, client_addr::text FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND query ILIKE $1`,
        [queryLike],
      )
    ).rows;
  /** The state of one session, or null once PostgreSQL has ended it. */
  const session = async (pid: number) =>
    (await pool.query<{ state: string }>('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0]?.state ?? null;

  /** The final SQL of contract §8: violating rows only. */
  async function violations(ignore: string[] = []) {
    const sql = readFileSync(join(__dirname, 'admission-final.sql'), 'utf8');
    return (await pool.query<{ check_name: string; event_id: string; detail: string }>(sql)).rows.filter(
      (row) => !ignore.includes(row.check_name),
    );
  }
  /**
   * The transition log replayed. `incomplete` is non-empty when the capture missed something:
   * it began with admission keys present, or its end state is not what Redis holds.
   */
  async function transitions() {
    const replay = replayAdmissionLog(monitor.entries);
    const incomplete = [...monitor.incomplete];
    for (const [id, replayed] of replay.namespaces) {
      const keys = `peakpass:admission:${id}:`;
      for (const name of ['waiting', 'active', 'claims'] as const) {
        if (!(await redis.exists(keys + name))) continue;
        const real = (await redis.zRange(keys + name, 0, -1)).filter((m) => m !== '__').sort();
        if (JSON.stringify(real) !== JSON.stringify([...replayed[name]].sort()))
          incomplete.push(`${name} of ${id}: Redis holds ${real.length}, the log ${replayed[name].length}`);
      }
    }
    // A namespace Redis holds and the log never saw is a capture that began too late.
    for await (const key of redis.scanIterator({ MATCH: 'peakpass:admission:*:active', COUNT: 100 })) {
      const id = key.slice('peakpass:admission:'.length, -':active'.length);
      if (!replay.namespaces.has(id)) incomplete.push(`${id} is in Redis and not in the log`);
    }
    return { ...replay, incomplete };
  }
  /** Marks the start of a scenario: `verify` reports the log violations from here on. */
  let since = 0;
  async function begin(name: string) {
    since = await redisNow();
    note('scenario', { name });
  }
  /**
   * The two checks every scenario ends with: the final SQL and the complete transition log. The
   * log is replayed from its beginning, and the violations of earlier scenarios stay theirs.
   */
  async function verify(ignore: string[] = []) {
    expect(await violations(ignore)).toEqual([]);
    const log = await transitions();
    expect(log.incomplete).toEqual([]);
    expect(log.violations.filter((violation) => violation.time >= since)).toEqual([]);
    return log;
  }
  /** What a capture that begins now would report: the reason it cannot be trusted, if any. */
  async function lateCapture() {
    const late = new Monitor(redisPort);
    await late.attach();
    late.detach();
    return late.incomplete;
  }
  const slots = async (eventId: string) => {
    const current = await control(eventId);
    return current ? (await redis.zCard(`peakpass:admission:${eventId}:${current.epoch}:active`)) - 1 : null;
  };
  /** Waits until no admitted entry and no unresolved claim is left. */
  const quiet = (eventId: string, timeoutMs = 90000) =>
    until(async () => (await slots(eventId)) === 0, timeoutMs, 'every slot to be returned', 500);
  /** Releases protection by the explicit transition and waits until a scheduler retired the namespace. */
  async function release(eventId: string) {
    const at = await protect(eventId, false);
    await until(async () => (await control(eventId)) === null, 30000, 'the namespace to be retired');
    return at;
  }
  /** The address PostgreSQL sees for each application container. */
  const addresses = async () =>
    new Map(
      await Promise.all(
        apps.map(async (app) => [
          await docker('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', app.id),
          app,
        ] as const),
      ),
    );
  /** The applications whose sessions wait for an advisory lock: a coordinator at the event gate. */
  async function gateWaiters(): Promise<AppBox[]> {
    const known = await addresses();
    const waiting = await pool.query<{ addr: string }>(
      `SELECT host(a.client_addr) AS addr FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND NOT l.granted`,
    );
    return waiting.rows.map((row) => known.get(row.addr)).filter((app): app is AppBox => !!app);
  }
  const advisoryWaiters = async () =>
    (await pool.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)).rowCount ?? 0;
  /**
   * Hands the gate on: a second holder queues behind whoever waits for the exclusive gate, the
   * current holder lets go, and this returns once the second holder has it. Everything that was
   * waiting for the exclusive gate has run exactly one transaction in between.
   */
  async function passGate(eventId: string, current: ReturnType<typeof holdGate>) {
    const waiting = await advisoryWaiters();
    const queued = holdGate(eventId);
    await Promise.race([
      queued.granted,
      until(async () => (await advisoryWaiters()) > waiting, 10000, 'the next gate holder to queue', 20),
    ]);
    await current.release();
    await queued.granted;
    return queued;
  }
  const entry = async (eventId: string, admission: AdmissionRef): Promise<Json | null> => {
    const raw = await redis.hGet(
      `peakpass:admission:${eventId}:${admission.admissionEpoch}:entries`,
      admission.admissionId,
    );
    return raw ? JSON.parse(raw) : null;
  };
  const results = async (eventId: string) =>
    (
      await pool.query<Json>(
        `SELECT admission_id AS "admissionId", user_id AS "userId", epoch::text, operation, outcome,
          reservation_id AS "reservationId", order_id AS "orderId", error_code AS "errorCode",
          pg_xact_commit_timestamp(xmin) AS "committedAt"
        FROM admission_results WHERE event_id=$1 ORDER BY 9, 1`,
        [eventId],
      )
    ).rows;
  const seats = async (eventId: string) =>
    (
      await pool.query<Json>(
        `SELECT e.available_seats AS available, e.total_seats AS total,
          (SELECT COUNT(*)::int FROM reservations WHERE event_id=e.id) AS reservations,
          (SELECT COUNT(*)::int FROM orders WHERE event_id=e.id) AS orders,
          (SELECT COUNT(*)::int FROM admission_results WHERE event_id=e.id) AS results
        FROM events e WHERE e.id=$1`,
        [eventId],
      )
    ).rows[0];

  // Faults. Every one acts on a container this fixture created.
  const fault = async (action: string, id: string, ...args: string[]) => {
    note(`docker ${action}`, { container: names.get(id) });
    await docker(action, ...args, id);
  };
  const redisFaults = {
    pause: () => fault('pause', redisId),
    unpause: () => fault('unpause', redisId),
    async stop() {
      await redis.disconnect().catch(() => undefined);
      monitor.detach();
      await fault('stop', redisId, '-t', '0');
    },
    /** Starts the stopped server. The log is attached before any application can write to it. */
    async start() {
      const attached = monitor.attach(true);
      await fault('start', redisId);
      await attached;
      redis = await newRedis();
    },
    async flush() {
      note('FLUSHALL');
      await redis.flushAll();
    },
  };
  const pgBack = async () => {
    await pool.end().catch(() => undefined);
    pool = newPool();
    await until(async () => {
      try {
        return (await pool.query('SELECT 1')).rowCount === 1;
      } catch {
        return false;
      }
    }, 60000, 'PostgreSQL to answer again', 200);
  };
  const pgFaults = {
    /** A fast shutdown and a start: every session is ended with an administrator-command error. */
    async restart() {
      await fault('restart', pgId, '-t', '20');
      await pgBack();
    },
    /** SIGKILL and a start: sessions end without a word and the server recovers from its log. */
    async crash() {
      await fault('kill', pgId, '--signal', 'KILL');
      await fault('start', pgId);
      await pgBack();
    },
  };
  const appFaults = {
    pause: (app: AppBox) => fault('pause', app.id),
    unpause: (app: AppBox) => fault('unpause', app.id),
    kill: (app: AppBox, signal = 'KILL') => fault('kill', app.id, '--signal', signal),
    start: async (app: AppBox) => {
      await fault('start', app.id);
      await ready(app);
    },
    /** The exit code once the container has stopped. */
    exited: async (app: AppBox, timeoutMs = 30000) =>
      (
        await until(async () => {
          const [running, code] = (
            await docker('inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', app.id)
          ).split(' ');
          return running === 'false' ? { code: Number(code) } : null;
        }, timeoutMs, `${app.name} to exit`, 200)
      ).code,
    logs: (app: AppBox) => docker('logs', app.id),
    /** When the container's process was started: unchanged as long as it has not restarted. */
    startedAt: (app: AppBox) => docker('inspect', '--format', '{{.State.StartedAt}}', app.id),
  };

  async function destroy(suite: string) {
    monitor.detach();
    if (EVIDENCE) {
      mkdirSync(EVIDENCE, { recursive: true });
      const lines = (rows: Json[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
      writeFileSync(join(EVIDENCE, `${suite}-notes.jsonl`), lines(notes));
      writeFileSync(join(EVIDENCE, `${suite}-requests.jsonl`), lines(requests));
      writeFileSync(join(EVIDENCE, `${suite}-transitions.log`), monitor.lines.join('\n') + '\n');
      for (const app of apps)
        writeFileSync(
          join(EVIDENCE, `${suite}-${names.get(app.id)}.log`),
          await docker('logs', app.id).catch((error) => String(error)),
        );
    }
    await redis.disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
    for (const id of created) {
      const owner = await docker('inspect', '--format', '{{index .Config.Labels "peakpass.fault-run"}}', id).catch(() => '');
      if (owner === prefix) await docker('rm', '-f', '-v', id).catch(() => undefined);
    }
    await docker('network', 'rm', prefix).catch(() => undefined);
  }

  return {
    prefix,
    apps,
    enabled,
    get pool() {
      return pool;
    },
    get redis() {
      return redis;
    },
    http,
    decided,
    buyer,
    settle,
    event,
    protect,
    control,
    policy,
    holdGate,
    slow,
    sleeping,
    pgLog,
    redisNow,
    backends,
    session,
    violations,
    transitions,
    begin,
    verify,
    lateCapture,
    slots,
    quiet,
    release,
    gateWaiters,
    passGate,
    entry,
    results,
    seats,
    note,
    requests,
    redisFaults,
    pgFaults,
    appFaults,
    ready,
    destroy,
    pgNow: async () => (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now,
  };
}
export type Buyer = Awaited<ReturnType<Topology['buyer']>>;
