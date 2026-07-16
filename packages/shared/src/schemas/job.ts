import { z } from 'zod';

import { NetworkIdSchema } from './network.js';

export const JobIdSchema = z.string().uuid();
export const JobStepIdSchema = z.string().uuid();

export const JobKindSchema = z.literal('network-lifecycle');
export const NetworkLifecycleActionSchema = z.enum(['up', 'stop', 'restart', 'down']);
export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const JobStepStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const JobEventTypeSchema = z.enum(['status', 'step', 'log']);
export const JobLogStreamSchema = z.enum(['stdout', 'stderr', 'system']);

export const JobStepSchema = z.object({
  id: JobStepIdSchema,
  sequence: z.number().int().positive(),
  name: z.string().min(1),
  status: JobStepStatusSchema,
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
});

export const JobSummarySchema = z.object({
  id: JobIdSchema,
  kind: JobKindSchema,
  networkId: NetworkIdSchema,
  action: NetworkLifecycleActionSchema,
  status: JobStatusSchema,
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
});

export const JobSchema = JobSummarySchema.extend({
  actor: z.string().min(1),
  exitCode: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  steps: z.array(JobStepSchema),
});

export const JobEventSchema = z.object({
  id: z.number().int().positive(),
  jobId: JobIdSchema,
  stepId: JobStepIdSchema.nullable(),
  type: JobEventTypeSchema,
  stream: JobLogStreamSchema.nullable(),
  message: z.string(),
  createdAt: z.string().datetime(),
});

export const JobListResponseSchema = z.object({
  items: z.array(JobSummarySchema),
  total: z.number().int().nonnegative(),
});

export const JobEventListResponseSchema = z.object({
  items: z.array(JobEventSchema),
  total: z.number().int().nonnegative(),
});

export const CreateNetworkActionRequestSchema = z.object({
  confirmation: z.string().trim().min(1).optional(),
});

export type JobId = z.infer<typeof JobIdSchema>;
export type JobKind = z.infer<typeof JobKindSchema>;
export type NetworkLifecycleAction = z.infer<typeof NetworkLifecycleActionSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobStepStatus = z.infer<typeof JobStepStatusSchema>;
export type JobEventType = z.infer<typeof JobEventTypeSchema>;
export type JobLogStream = z.infer<typeof JobLogStreamSchema>;
export type JobStep = z.infer<typeof JobStepSchema>;
export type JobSummary = z.infer<typeof JobSummarySchema>;
export type Job = z.infer<typeof JobSchema>;
export type JobEvent = z.infer<typeof JobEventSchema>;
export type JobListResponse = z.infer<typeof JobListResponseSchema>;
export type JobEventListResponse = z.infer<typeof JobEventListResponseSchema>;
export type CreateNetworkActionRequest = z.infer<typeof CreateNetworkActionRequestSchema>;
