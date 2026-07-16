import {
  JobEventListResponseSchema,
  JobIdSchema,
  JobListResponseSchema,
  JobSchema,
  NetworkIdSchema,
} from '@plus-fabric/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

import { JobService, JobServiceError } from './job-service.js';

type JobRouteOptions = {
  jobService: JobService;
};

export const registerJobRoutes: FastifyPluginAsync<JobRouteOptions> = async (app, options) => {
  app.get('/', async (request, reply) => {
    const requestedNetworkId = (request.query as { networkId?: unknown }).networkId;
    const networkId =
      requestedNetworkId === undefined ? undefined : NetworkIdSchema.safeParse(requestedNetworkId);
    if (networkId !== undefined && !networkId.success) {
      return reply.code(400).send({
        error: 'invalid_network_id',
        message: 'The network id is invalid.',
      });
    }

    const items = await options.jobService.list(networkId?.data);
    return JobListResponseSchema.parse({ items, total: items.length });
  });

  app.get('/:jobId', async (request, reply) => {
    const jobId = parseJobId(request.params, reply);
    if (!jobId) return;

    try {
      return JobSchema.parse(await options.jobService.get(jobId));
    } catch (error) {
      return sendJobError(error, reply);
    }
  });

  app.get('/:jobId/events', async (request, reply) => {
    const jobId = parseJobId(request.params, reply);
    if (!jobId) return;

    const afterId = parseAfterId(request.query, request.headers['last-event-id'], reply);
    if (afterId === null) return;

    try {
      await options.jobService.get(jobId);
      if (request.headers.accept?.includes('text/event-stream')) {
        return streamJobEvents(jobId, afterId, options.jobService, request.raw, reply);
      }

      const items = await options.jobService.getEvents(jobId, afterId);
      return JobEventListResponseSchema.parse({ items, total: items.length });
    } catch (error) {
      return sendJobError(error, reply);
    }
  });

  app.post('/:jobId/cancel', async (request, reply) => {
    const jobId = parseJobId(request.params, reply);
    if (!jobId) return;

    try {
      return JobSchema.parse(await options.jobService.cancel(jobId));
    } catch (error) {
      return sendJobError(error, reply);
    }
  });
};

function parseJobId(params: unknown, reply: FastifyReply): string | null {
  const parsed = JobIdSchema.safeParse((params as { jobId?: unknown }).jobId);
  if (parsed.success) return parsed.data;
  reply.code(400).send({
    error: 'invalid_job_id',
    message: 'The job id is invalid.',
  });
  return null;
}

function parseAfterId(
  query: unknown,
  lastEventId: string | string[] | undefined,
  reply: FastifyReply,
): number | null {
  const raw =
    (query as { after?: unknown }).after ??
    (Array.isArray(lastEventId) ? lastEventId[0] : lastEventId) ??
    '0';
  const afterId = typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (Number.isInteger(afterId) && afterId >= 0) return afterId;
  reply.code(400).send({
    error: 'invalid_event_cursor',
    message: 'The job event cursor is invalid.',
  });
  return null;
}

async function streamJobEvents(
  jobId: string,
  afterId: number,
  jobService: JobService,
  request: NodeJS.EventEmitter,
  reply: FastifyReply,
) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write('retry: 2000\n\n');

  let lastSentId = afterId;
  let closed = false;
  const writeEvent = (event: Awaited<ReturnType<JobService['getEvents']>>[number]) => {
    if (closed || event.id <= lastSentId) return;
    lastSentId = event.id;
    reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const unsubscribe = jobService.subscribe(jobId, writeEvent);
  for (const event of await jobService.getEvents(jobId, afterId)) writeEvent(event);

  const heartbeat = setInterval(() => {
    if (!closed) reply.raw.write(': heartbeat\n\n');
  }, 15_000);
  heartbeat.unref();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.once('close', cleanup);
  reply.raw.once('close', cleanup);
}

function sendJobError(error: unknown, reply: FastifyReply) {
  if (error instanceof JobServiceError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}
