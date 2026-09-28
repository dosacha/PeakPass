import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { resolve } from 'path';
import { Pool, PoolConfig } from 'pg';

const eventIds = ['a3ae4dfe-160b-5ec7-9a08-125b9235b45f', '4ed183c2-ab4d-54a8-8404-d4f5b932e9a6'];
const tierIds = ['91dfab04-048e-53af-b2ec-50bcaeff16e1', '67de1e3d-a711-593e-813f-b54b091e32ed'];
const workspace = resolve(__dirname, '../../..');

describe('real seed command on an isolated migrated PostgreSQL schema', () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let publicBefore: unknown;
  let schemaCreated = false;
  let connection: PoolConfig;
  const publicUserId = randomUUID();
  const publicEventId = randomUUID();

  beforeAll(async () => {
    const config = (await import('@/infra/config')).loadConfig();
    connection = {
      host: config.DB_HOST, port: config.DB_PORT, user: config.DB_USER,
      password: config.DB_PASSWORD, database: config.DB_NAME, connectionTimeoutMillis: 5000,
    };
    admin = new Pool({ ...connection, options: '-c search_path=public' });
    await admin.query('INSERT INTO public.users (id, email, name) VALUES ($1, $2, $3)',
      [publicUserId, `${publicUserId}@seed-public.test`, 'Existing public user']);
    await admin.query(`INSERT INTO public.events
      (id, name, starts_at, ends_at, total_seats, available_seats, pricing)
      VALUES ($1, 'Existing public event', NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days', 5, 4, '[]')`,
    [publicEventId]);
    publicBefore = await publicSnapshot();
  });

  beforeEach(async () => {
    schema = `seed_idempotency_${randomUUID().replace(/-/g, '')}`;
    if (!/^seed_idempotency_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid owned schema name');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    pool = new Pool({ ...connection, options: `-c search_path=${schema},public` });
    const migration = runCommand('src/infra/migrations/runner.ts', 'up');
    expect(migration).toMatchObject({ status: 0 });
    const table = await pool.query(`SELECT table_schema FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = 'events'`, [schema]);
    expect(table.rows).toEqual([{ table_schema: schema }]);
    expect((await pool.query('SELECT current_schema() AS schema')).rows).toEqual([{ schema }]);
  }, 30000);

  afterEach(async () => {
    await pool?.end();
    try {
      expect(await publicSnapshot()).toEqual(publicBefore);
    } finally {
      if (schemaCreated && /^seed_idempotency_[a-f0-9]{32}$/.test(schema)) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        schemaCreated = false;
      }
    }
  });

  afterAll(async () => {
    await admin?.query('DELETE FROM public.events WHERE id = $1', [publicEventId]);
    await admin?.query('DELETE FROM public.users WHERE id = $1', [publicUserId]);
    await admin?.end();
  });

  function runCommand(script: string, ...args: string[]) {
    const result = spawnSync(process.execPath, [require.resolve('tsx/cli'), script, ...args], {
      cwd: workspace,
      env: { ...process.env, PGOPTIONS: `-c search_path=${schema},public`, LOG_LEVEL: 'warn' },
      encoding: 'utf8', timeout: 20000,
    });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  }

  async function publicSnapshot() {
    const snapshots = [];
    for (const table of ['users', 'events', 'orders', 'reservations', 'tickets', 'payment_records']) {
      snapshots.push((await admin.query(`SELECT row_to_json(t) AS row FROM public.${table} t ORDER BY id`)).rows);
    }
    return snapshots;
  }

  it('seeds twice without duplicate events or tiers and reuses an existing email user', async () => {
    const existingUserId = randomUUID();
    await pool.query('INSERT INTO users (id, email, name) VALUES ($1, $2, $3)',
      [existingUserId, 'user1@example.com', 'Existing customer']);
    expect(runCommand('src/infra/seed.ts')).toMatchObject({ status: 0 });
    const firstEvents = (await pool.query('SELECT * FROM events ORDER BY name')).rows;
    const firstUsers = (await pool.query('SELECT * FROM users ORDER BY email')).rows;
    expect(firstEvents).toHaveLength(2);
    for (const event of firstEvents) {
      expect(event.starts_at.getTime()).toBeGreaterThan(Date.now());
      expect(event.ends_at.getTime() - event.starts_at.getTime()).toBe(2 * 60 * 60 * 1000);
    }
    expect(runCommand('src/infra/seed.ts')).toMatchObject({ status: 0 });
    const secondEvents = (await pool.query('SELECT * FROM events ORDER BY name')).rows;
    expect(secondEvents).toHaveLength(2);
    expect(secondEvents).toEqual(firstEvents);
    expect(secondEvents.map((event) => event.id).sort()).toEqual([...eventIds].sort());
    expect(secondEvents.flatMap((event) => event.pricing.map((tier: { id: string }) => tier.id)).sort())
      .toEqual([...tierIds].sort());
    expect((await pool.query('SELECT * FROM users ORDER BY email')).rows).toEqual(firstUsers);
    expect(firstUsers[0]).toMatchObject({ id: existingUserId, name: 'Existing customer' });
  }, 30000);

  it('preserves inventory, prices, dates, tiers, order/reservation references and legacy random rows', async () => {
    const legacyId = randomUUID();
    await pool.query(`INSERT INTO events
      (id, name, description, starts_at, ends_at, total_seats, available_seats, pricing)
      VALUES ($1, 'Node.js Workshop', 'Legacy random fixture', NOW() + INTERVAL '1 day',
      NOW() + INTERVAL '2 days', 9, 4, $2)`,
    [legacyId, JSON.stringify([{ id: randomUUID(), name: 'Legacy tier', price: 7, quantity: 9 }])]);
    expect(runCommand('src/infra/seed.ts')).toMatchObject({ status: 0 });
    const event = (await pool.query(`SELECT * FROM events WHERE id <> $1 AND name = 'Node.js Workshop'`, [legacyId])).rows[0];
    const user = (await pool.query("SELECT id FROM users WHERE email = 'user1@example.com'")).rows[0];
    const tierId = event.pricing[0].id;
    const pricing = [{ ...event.pricing[0], price: 75 }, { id: randomUUID(), name: 'Added tier', price: 120, quantity: 2 }];
    await pool.query(`UPDATE events SET available_seats = 97, pricing = $2,
      starts_at = NOW() + INTERVAL '10 days', ends_at = NOW() + INTERVAL '11 days' WHERE id = $1`,
    [event.id, JSON.stringify(pricing)]);
    const reservationId = randomUUID();
    await pool.query(`INSERT INTO reservations (id, user_id, event_id, quantity, tier_id, expires_at)
      VALUES ($1, $2, $3, 2, $4, NOW() + INTERVAL '1 hour')`, [reservationId, user.id, event.id, tierId]);
    await pool.query(`INSERT INTO orders
      (id, user_id, event_id, quantity, tier_id, unit_price, total_amount, idempotency_key, reservation_id)
      VALUES ($1, $2, $3, 2, $4, 75, 150, $5, $6)`,
    [randomUUID(), user.id, event.id, tierId, randomUUID(), reservationId]);
    const beforeEvents = (await pool.query('SELECT * FROM events ORDER BY id')).rows;
    const beforeOrders = (await pool.query('SELECT * FROM orders ORDER BY id')).rows;
    const beforeReservations = (await pool.query('SELECT * FROM reservations ORDER BY id')).rows;
    expect(runCommand('src/infra/seed.ts')).toMatchObject({ status: 0 });
    expect((await pool.query('SELECT * FROM events ORDER BY id')).rows).toEqual(beforeEvents);
    expect((await pool.query('SELECT * FROM orders ORDER BY id')).rows).toEqual(beforeOrders);
    expect((await pool.query('SELECT * FROM reservations ORDER BY id')).rows).toEqual(beforeReservations);
  }, 30000);

  it('fails safely when a reserved stable event ID belongs to a different fixture', async () => {
    await pool.query(`INSERT INTO events
      (id, name, starts_at, ends_at, total_seats, available_seats, pricing)
      VALUES ($1, 'Unrelated customer event', NOW() + INTERVAL '1 day',
      NOW() + INTERVAL '2 days', 8, 3, '[]')`, [eventIds[0]]);
    const beforeEvents = (await pool.query('SELECT * FROM events ORDER BY id')).rows;
    const result = runCommand('src/infra/seed.ts');
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/collision/i);
    expect((await pool.query('SELECT * FROM events ORDER BY id')).rows).toEqual(beforeEvents);
    expect((await pool.query('SELECT * FROM users')).rows).toHaveLength(0);
  }, 30000);
});
