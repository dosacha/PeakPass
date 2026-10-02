import 'dotenv/config';
import { initLogger } from '@/infra/logger';
import { initRedis } from '@/infra/redis/client';
import { initPostgresPool } from '@/infra/postgres/client';
import { AdmissionService } from '@/core/services/admission.service';

// Pause only in a disposable child, at real command/commit boundaries; parent kills it.
async function main() {
  initLogger();
  const [eventId, stage] = process.argv.slice(2);
  const redis = await initRedis(),
    pool = await initPostgresPool();
  const pause = async () => {
    process.send?.({ stage });
    await new Promise(() => undefined);
  };
  const evaluate = redis.eval.bind(redis);
  redis.eval = (async (...args: Parameters<typeof evaluate>) => {
    const result = await evaluate(...args);
    const operation = (args[1] as { arguments: string[] }).arguments[0];
    if (
      (stage === 'frozen' && operation === 'freeze') ||
      (stage === 'initialized' && operation === 'initialize')
    )
      await pause();
    return result;
  }) as typeof redis.eval;
  const wrapped = new WeakSet();
  pool.on('acquire', (client) => {
    if (wrapped.has(client)) return;
    wrapped.add(client);
    const query = client.query.bind(client);
    let pending = '';
    client.query = (async (sql: string, ...args: unknown[]) => {
      const result = await (query as unknown as (...args:unknown[])=>Promise<unknown>)(sql, ...args);
      if (sql.includes('UPDATE admission_events SET generation')) pending = 'barrier';
      if (sql.includes("UPDATE admission_events SET phase='open'")) pending = 'open';
      if (sql === 'COMMIT' && pending === stage) await pause();
      if (sql === 'COMMIT' || sql === 'ROLLBACK') pending = '';
      return result;
    }) as typeof client.query;
  });
  const service = new AdmissionService(true);
  await service.verifyEnvironment();
  await service.recover(eventId);
  throw new Error('Expected fixture checkpoint was not reached');
}
void main().catch((error) => {
  process.send?.({ error: String(error) });
  process.exit(1);
});
