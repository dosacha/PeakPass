import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AdmissionService, admissionService } from '@/core/services/admission.service';
import { AdmissionError } from '@/core/models/admission';

const uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
const eventParams = z.object({ eventId: uuid }).strict();
const joinBody = z.object({ epoch: uuid, joinRequestId: uuid }).strict();
const cancelBody = z.object({ epoch: uuid }).strict();
declare module 'fastify' {
  interface FastifyContextConfig {
    admission?: boolean;
  }
}

export async function registerAdmissionRoutes(
  app: FastifyInstance,
  options: { service?: AdmissionService } = {},
) {
  const service = options.service ?? admissionService;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (
      request.method === 'GET' &&
      (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding'])
    ) {
      throw new AdmissionError('ADMISSION_INVALID_INPUT', 400);
    }
  });
  app.addHook('preHandler', async (request) => {
    const user = uuid.safeParse(request.user?.id);
    if (!user.success) throw new AdmissionError('UNAUTHENTICATED', 401);
    request.user!.id = user.data;
    z.object({}).strict().parse(request.query);
  });
  app.setErrorHandler((error, _request, reply) => {
    const invalid =
      error instanceof z.ZodError ||
      error.statusCode === 400 ||
      error.statusCode === 415 ||
      error.code === 'FST_ERR_CTP_BODY_TOO_LARGE';
    const mapped =
      error instanceof AdmissionError
        ? error
        : new AdmissionError(
            invalid ? 'ADMISSION_INVALID_INPUT' : 'ADMISSION_UNAVAILABLE',
            invalid ? 400 : 503,
            invalid ? null : 1000,
          );
    if (mapped.statusCode === 429)
      reply.header('Retry-After', Math.ceil((mapped.nextPollAfterMs ?? 1000) / 1000));
    return reply
      .code(mapped.statusCode)
      .send({
        error: { code: mapped.code, message: mapped.message },
        nextPollAfterMs: mapped.nextPollAfterMs,
        ...(mapped.admission ? { admission: mapped.admission } : {}),
      });
  });
  const config = { admission: true };
  app.get('/events/:eventId/admissions/me', { config }, async (request) => {
    const { eventId } = eventParams.parse(request.params);
    return service.status(eventId, request.user!.id);
  });
  app.post('/events/:eventId/admissions', { config }, async (request, reply) => {
    const { eventId } = eventParams.parse(request.params),
      { epoch, joinRequestId } = joinBody.parse(request.body);
    const result = await service.join(eventId, request.user!.id, epoch, joinRequestId);
    return reply.code(result.created ? 201 : 200).send(result.body);
  });
  app.delete('/events/:eventId/admissions/:admissionId', { config }, async (request) => {
    const { eventId, admissionId } = eventParams
      .extend({ admissionId: uuid })
      .parse(request.params);
    const { epoch } = cancelBody.parse(request.body);
    return service.cancel(eventId, request.user!.id, epoch, admissionId);
  });
}
