import { z } from 'zod';

export const NetworkDriverSchema = z.enum(['fabric-compose']);
export const NetworkManagementModeSchema = z.enum(['imported', 'managed']);
export const NetworkRuntimeStatusSchema = z.enum([
  'unknown',
  'stopped',
  'starting',
  'running',
  'degraded',
  'stopping',
  'error',
]);

export const NetworkSummarySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  driver: NetworkDriverSchema,
  managementMode: NetworkManagementModeSchema,
  status: NetworkRuntimeStatusSchema,
  fabricVersion: z.string().nullable(),
  organizationCount: z.number().int().nonnegative(),
  channelCount: z.number().int().nonnegative(),
  nodeCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});

export const NetworkListResponseSchema = z.object({
  items: z.array(NetworkSummarySchema),
  total: z.number().int().nonnegative(),
});

export type NetworkDriver = z.infer<typeof NetworkDriverSchema>;
export type NetworkManagementMode = z.infer<typeof NetworkManagementModeSchema>;
export type NetworkRuntimeStatus = z.infer<typeof NetworkRuntimeStatusSchema>;
export type NetworkSummary = z.infer<typeof NetworkSummarySchema>;
export type NetworkListResponse = z.infer<typeof NetworkListResponseSchema>;
