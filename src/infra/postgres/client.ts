import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getConfig } from '../config';
import { getLogger } from '../logger';

let pool: Pool | null = null;

export async function initPostgresPool(): Promise<Pool> {
  const config = getConfig();
  const logger = getLogger();

  if (pool) {
    return pool;
  }

  pool = new Pool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    min: config.DB_POOL_MIN,
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected PostgreSQL pool error');
  });

  const client = await pool.connect();
  await client.query('SELECT NOW()');
  client.release();

  logger.info(`PostgreSQL connected to ${config.DB_HOST}:${config.DB_PORT}/${config.DB_NAME}`);
  logger.info(`Pool configured: min=${config.DB_POOL_MIN}, max=${config.DB_POOL_MAX}`);

  return pool;
}

export function getPostgresPool(): Pool {
  if (!pool) {
    throw new Error('PostgreSQL pool not initialized. Call initPostgresPool() first.');
  }

  return pool;
}

export async function closePostgresPool(): Promise<void> {
  if (pool) {
    await pool.end();
    getLogger().info('PostgreSQL pool closed');
    pool = null;
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<QueryResult<T>> {
  if (!pool) {
    throw new Error('PostgreSQL pool not initialized. Call initPostgresPool() first.');
  }

  const client = await pool.connect();
  try {
    return await client.query<T>(text, values);
  } finally {
    client.release();
  }
}

export async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pool) {
    throw new Error('PostgreSQL pool not initialized. Call initPostgresPool() first.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function serializableTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!pool) {
    throw new Error('PostgreSQL pool not initialized. Call initPostgresPool() first.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export type { PoolClient, QueryResult };
