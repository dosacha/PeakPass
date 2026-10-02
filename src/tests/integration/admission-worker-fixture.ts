import 'dotenv/config';
import { initLogger } from '@/infra/logger';
import { initRedis, closeRedis } from '@/infra/redis/client';
import { runAdmission } from '@/infra/redis/admission';

// Separate Redis connections/processes, no production startup or activation bypass.
async function main() {
  initLogger();
  await initRedis();
  process.on('message', async (message: { eventId: string; epoch: string }) => {
  try {
    process.send?.(await runAdmission(message.eventId, message.epoch, 'tick'));
  } catch (error) {
    process.send?.({ error: String(error) });
  }
  });
  process.on('disconnect', async () => {
  await closeRedis();
  });
  process.send?.({ ready: true });
}
void main().catch(error=>{process.send?.({error:String(error)}); process.exit(1);});
