import { readdir, readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PoolClient } from 'pg';
import { initPostgresPool } from '../postgres/client';
import { initLogger } from '../logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Migration {
  filename: string;
  name: string;
  version: number;
  sql: string;
}

async function getMigrations(): Promise<Migration[]> {
  const migrationsDir = __dirname;
  const files = await readdir(migrationsDir);

  const migrations: Migration[] = [];
  for (const file of files) {
    if (!file.endsWith('.sql')) continue;
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) continue;

    const [, versionStr, name] = match;
    const version = parseInt(versionStr, 10);
    const filepath = join(migrationsDir, file);
    const sql = await readFile(filepath, 'utf-8');

    migrations.push({ filename: file, name, version, sql });
  }

  return migrations.sort((a, b) => a.version - b.version);
}

async function initMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      executed_at TIMESTAMPTZ DEFAULT NOW(),
      execution_time_ms INTEGER
    )
  `);
}

async function getExecutedMigrations(client: PoolClient): Promise<Set<number>> {
  const result = await client.query('SELECT version FROM migrations ORDER BY version');
  return new Set(result.rows.map((row) => row.version));
}

async function runUpMigrations(): Promise<void> {
  const { loadConfig } = await import('../config');
  loadConfig();

  const logger = initLogger();
  const pool = await initPostgresPool();
  const client = await pool.connect();

  try {
    await initMigrationTable(client);
    const executed = await getExecutedMigrations(client);
    const migrations = await getMigrations();

    let totalMigrations = 0;
    for (const migration of migrations) {
      if (executed.has(migration.version)) {
        logger.info(`Skipped: ${migration.filename}`);
        continue;
      }

      const startTime = Date.now();
      logger.info(`Running: ${migration.filename}`);

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        const executionTime = Date.now() - startTime;
        await client.query(
          'INSERT INTO migrations (version, name, execution_time_ms) VALUES ($1, $2, $3)',
          [migration.version, migration.name, executionTime],
        );
        await client.query('COMMIT');
        logger.info(`Completed: ${migration.filename} (${executionTime}ms)`);
        totalMigrations++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    logger.info(`All migrations complete. Total new: ${totalMigrations}`);
  } finally {
    client.release();
    await pool.end();
  }
}

async function runDownMigrations(): Promise<void> {
  const logger = initLogger();
  logger.warn('Down migrations not yet implemented. Please handle manually.');
  process.exit(0);
}

const command = process.argv[2] || 'up';
if (command === 'up') {
  runUpMigrations().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
} else if (command === 'down') {
  runDownMigrations().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
