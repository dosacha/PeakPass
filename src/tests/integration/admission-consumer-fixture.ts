import 'dotenv/config';
import { initLogger } from '@/infra/logger';
import { initRedis } from '@/infra/redis/client';
import { initPostgresPool } from '@/infra/postgres/client';
import { readAdmissionPolicy, lockAdmission } from '@/infra/postgres/admission-policy';
import { AdmissionService } from '@/core/services/admission.service';

// A consumer in a disposable child: it stops between its Redis claim and its PostgreSQL commit,
// still holding the event gate and the admission lock. The parent kills the process.
async function main() {
  initLogger();
  const [eventId, userId, admissionId, epoch, fingerprint] = process.argv.slice(2);
  await initRedis();
  const client = await (await initPostgresPool()).connect();
  const service = new AdmissionService(true);
  await service.verifyEnvironment();
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await readAdmissionPolicy(client, eventId);
  await lockAdmission(client, admissionId);
  await service.claim({ eventId, userId, admissionId, epoch, fingerprint });
  process.send?.({ claimed: true });
  await new Promise(() => undefined);
}
void main().catch((error) => {
  process.send?.({ error: String(error) });
  process.exit(1);
});
