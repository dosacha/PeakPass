import { admissionService, AdmissionService } from '@/core/services/admission.service';
import { admissionProfile } from '@/core/models/admission';
import { getLogger } from '@/infra/logger';

export function startAdmissionScheduler(
  service: Pick<AdmissionService, 'maintain' | 'stop'> = admissionService,
  intervalMs = admissionProfile.tickMs,
) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<void>;
  async function run() {
    try {
      await service.maintain(() => stopped);
    } catch (error) {
      getLogger().error({ err: error }, 'Admission iteration failed; new admission remains closed');
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          inflight = run();
        }, intervalMs);
        timer.unref();
      }
    }
  }
  inflight = run();
  return {
    stop(): Promise<void> {
      if (!stopped) {
        stopped = true;
        if (timer) clearTimeout(timer);
        service.stop();
      }
      return inflight;
    },
  };
}
