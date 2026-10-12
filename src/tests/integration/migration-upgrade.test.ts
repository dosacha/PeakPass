import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { getConfig } from '@/infra/config';

// A database that stopped at migration 011 and holds rows, upgraded by the current runner. The
// databases are scratch databases of this test in the configured PostgreSQL, created and dropped
// here; the configured database itself is not touched. The configured role needs CREATEDB.
jest.setTimeout(180000);

const dir = 'src/infra/migrations';
const files = readdirSync(dir)
  .filter((file) => /^\d+_.+\.sql$/.test(file))
  .sort();
const version = (file: string) => parseInt(file, 10);

describe('upgrade of an existing 011 database by the migration runner', () => {
  const config = getConfig();
  const names: string[] = [];
  const clients: Client[] = [];
  let admin: Client;

  const connect = async (database: string) => {
    const client = new Client({
      host: config.DB_HOST,
      port: config.DB_PORT,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      database,
    });
    await client.connect();
    clients.push(client);
    return client;
  };
  async function scratch() {
    const name = `peakpass_upgrade_${randomUUID().replace(/-/g, '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    names.push(name);
    return { name, db: await connect(name) };
  }
  // The real runner, as `npm run migrate:up` starts it, against one scratch database.
  const migrate = (database: string) =>
    promisify(execFile)(process.execPath, ['--import', 'tsx', `${dir}/runner.ts`, 'up'], {
      env: { ...process.env, DB_NAME: database },
      windowsHide: true,
    });
  const rows = async (db: Client, table: string) =>
    (
      await db.query(
        `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]')::text AS rows FROM ${table} t`,
      )
    ).rows[0].rows as string;
  // The tables the product had at 011. A later migration that changes their rows changes this test.
  const data = async (db: Client) => {
    const tables: Record<string, string> = {};
    for (const table of [
      'users',
      'events',
      'reservations',
      'orders',
      'payment_records',
      'payment_callback_keys',
      'tickets',
    ])
      tables[table] = await rows(db, table);
    return tables;
  };
  // Columns (type, character length, nullability, default), constraints, indexes and the names of
  // sequences of the public schema, and every trigger of the database that is not internal, as
  // text. Not compared, for example: function bodies, the order of columns, numeric precision and
  // scale, sequence parameters.
  const schema = async (db: Client) =>
    (
      await db.query(`
        SELECT 'column' AS kind, table_name || '.' || column_name AS name,
          concat_ws(' ', data_type, character_maximum_length, is_nullable, column_default) AS definition
        FROM information_schema.columns WHERE table_schema = 'public'
        UNION ALL
        SELECT 'constraint', conrelid::regclass || '.' || conname, pg_get_constraintdef(oid)
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace
        UNION ALL
        SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
        UNION ALL
        SELECT 'trigger', tgrelid::regclass || '.' || tgname, pg_get_triggerdef(oid)
        FROM pg_trigger WHERE NOT tgisinternal
        UNION ALL
        SELECT 'sequence', sequencename, NULL FROM pg_sequences WHERE schemaname = 'public'
        ORDER BY 1, 2`)
    ).rows;

  beforeAll(async () => {
    admin = await connect(config.DB_NAME);
  });
  afterAll(async () => {
    for (const client of clients.reverse()) await client.end().catch(() => undefined);
    const cleaner = await connect(config.DB_NAME);
    for (const name of names) await cleaner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleaner.end();
  });

  it('applies only the files after 011, keeps every existing row, backfills the policy and changes nothing when run again', async () => {
    const { name, db } = await scratch();
    // The 011 state is built here, not by an old runner: files 001-011 in order, each recorded in
    // the runner's own table as the runner records it. The upgrade and the rerun are the runner.
    await db.query(`CREATE TABLE migrations (
      id SERIAL PRIMARY KEY, version INTEGER UNIQUE NOT NULL, name VARCHAR(255) NOT NULL,
      executed_at TIMESTAMPTZ DEFAULT NOW(), execution_time_ms INTEGER)`);
    for (const file of files.filter((f) => version(f) <= 11)) {
      await db.query('BEGIN');
      await db.query(readFileSync(join(dir, file), 'utf8'));
      await db.query(
        'INSERT INTO migrations (version, name, execution_time_ms) VALUES ($1, $2, 0)',
        [version(file), file.replace(/^\d+_|\.sql$/g, '')],
      );
      await db.query('COMMIT');
    }
    expect((await db.query(`SELECT to_regclass('admission_events') AS t`)).rows[0].t).toBeNull();

    // Rows of every table the product had at 011: a held reservation, a converted one with its
    // paid order, settlement, callback key and ticket, and a pending direct order.
    const [buyer, other] = [randomUUID(), randomUUID()];
    const [sale, idle] = [randomUUID(), randomUUID()];
    const [held, converted] = [randomUUID(), randomUUID()];
    const [paid, pending] = [randomUUID(), randomUUID()];
    const [paidKey, pendingKey, callbackKey] = [randomUUID(), randomUUID(), randomUUID()];
    await db.query('INSERT INTO users(id,email) VALUES($1,$2),($3,$4)', [
      buyer,
      `${buyer}@upgrade.test`,
      other,
      `${other}@upgrade.test`,
    ]);
    await db.query(
      `INSERT INTO events(id,name,starts_at,ends_at,total_seats,available_seats,pricing,status)
      VALUES($1,'upgrade sale',NOW()+interval '1 hour',NOW()+interval '2 hours',10,5,$3,'published'),
        ($2,'upgrade idle',NOW()+interval '1 hour',NOW()+interval '2 hours',4,4,$3,'draft')`,
      [sale, idle, JSON.stringify([{ id: 'general', name: 'General', price: 50, quantity: 10 }])],
    );
    await db.query(
      `INSERT INTO reservations(id,user_id,event_id,quantity,tier_id,expires_at,status)
      VALUES($1,$3,$4,2,'general',NOW()+interval '5 minutes','active'),
        ($2,$3,$4,2,'general',NOW()+interval '5 minutes','converted')`,
      [held, converted, buyer, sale],
    );
    await db.query(
      `INSERT INTO orders(id,user_id,event_id,quantity,tier_id,unit_price,total_amount,status,
        idempotency_key,reservation_id,paid_at)
      VALUES($1,$3,$5,2,'general',50,100,'paid',$6,$8,NOW()),($2,$4,$5,1,'general',50,50,'pending',$7,NULL,NULL)`,
      [paid, pending, buyer, other, sale, paidKey, pendingKey, converted],
    );
    await db.query(
      `INSERT INTO payment_records(id,order_id,status,provider_transaction_id,idempotency_key,webhook_received_at)
      VALUES($1,$4,'pending',NULL,$6,NULL),($2,$5,'pending',NULL,$7,NULL),($3,$4,'settled','upgrade-provider',$8,NOW())`,
      [randomUUID(), randomUUID(), randomUUID(), paid, pending, paidKey, pendingKey, callbackKey],
    );
    await db.query(
      `INSERT INTO payment_callback_keys(idempotency_key,order_id,provider_transaction_id,callback_status)
      VALUES($1,$2,'upgrade-provider','settled')`,
      [callbackKey, paid],
    );
    await db.query(
      `INSERT INTO tickets(id,order_id,event_id,user_id,ticket_number,status)
      VALUES($1,$3,$4,$5,'UPGRADE-1','active'),($2,$3,$4,$5,'UPGRADE-2','active')`,
      [randomUUID(), randomUUID(), paid, sale, buyer],
    );
    const before = await data(db);
    const recorded = await rows(db, 'migrations');

    await migrate(name);

    // Only the later files ran: the eleven recorded rows are as they were, 012 and 013 were added.
    const added = (
      await db.query('SELECT version FROM migrations WHERE version > 11 ORDER BY version')
    ).rows;
    expect(added.map((row) => row.version)).toEqual(files.map(version).filter((v) => v > 11));
    expect(added.map((row) => row.version)).toEqual(expect.arrayContaining([12, 13]));
    expect(await rows(db, '(SELECT * FROM migrations WHERE version <= 11)')).toBe(recorded);
    expect(await data(db)).toEqual(before);
    // 012 gives every existing event its unprotected policy; 013 adds an empty ledger.
    expect(
      (
        await db.query(
          `SELECT event_id AS "eventId", protected, generation::text, phase, redis_namespace AS namespace
          FROM admission_events ORDER BY event_id`,
        )
      ).rows,
    ).toEqual(
      [sale, idle].sort().map((eventId) => ({
        eventId,
        protected: false,
        generation: '0',
        phase: 'recovering',
        namespace: `peakpass:admission:${eventId}:`,
      })),
    );
    expect((await db.query('SELECT COUNT(*)::int AS n FROM admission_results')).rows[0].n).toBe(0);
    // The upgraded schema is the one the runner builds on an empty database.
    const fresh = await scratch();
    await migrate(fresh.name);
    const upgraded = await schema(db);
    expect(upgraded.length).toBeGreaterThan(0);
    expect(upgraded).toEqual(await schema(fresh.db));

    const migrations = await rows(db, 'migrations');
    const policies = await rows(db, 'admission_events');
    await migrate(name);
    expect(await rows(db, 'migrations')).toBe(migrations);
    expect(await rows(db, 'admission_events')).toBe(policies);
    expect(await data(db)).toEqual(before);
    expect(await schema(db)).toEqual(upgraded);
  });
});
