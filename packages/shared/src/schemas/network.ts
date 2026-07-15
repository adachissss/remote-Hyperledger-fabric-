import { z } from 'zod';

export const NetworkIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, 'Use lowercase letters, numbers, and hyphens.');

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

export const ImportNetworkRequestSchema = z.object({
  id: NetworkIdSchema,
  displayName: z.string().trim().min(1).max(100),
  driver: z.literal('fabric-compose'),
  workspaceRoot: z.string().trim().min(1),
  configPath: z.string().trim().min(1).default('config/orgs.yaml'),
  composeProject: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use a valid Docker Compose project name.'),
  fabricVersion: z.string().trim().min(1).nullable().default(null),
  fabricCaVersion: z.string().trim().min(1).nullable().default(null),
});

export const NetworkNodeAddressSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int().min(1).max(65535),
});

export const NetworkPeerOrganizationSchema = z.object({
  name: z.string(),
  mspId: z.string(),
  domain: z.string(),
  peerCount: z.number().int().nonnegative(),
  anchorPeers: z.array(NetworkNodeAddressSchema),
});

export const NetworkChannelConfigurationSchema = z.object({
  name: z.string(),
  profile: z.string().nullable(),
  memberOrganizations: z.array(z.string()),
});

export const RedactedNetworkConfigurationSchema = z.object({
  networkId: NetworkIdSchema,
  networkName: z.string(),
  domain: z.string(),
  dockerNetwork: z.string(),
  tlsEnabled: z.boolean(),
  orderers: z.array(NetworkNodeAddressSchema),
  peerOrganizations: z.array(NetworkPeerOrganizationSchema),
  channels: z.array(NetworkChannelConfigurationSchema),
});

export type NetworkDriver = z.infer<typeof NetworkDriverSchema>;
export type NetworkManagementMode = z.infer<typeof NetworkManagementModeSchema>;
export type NetworkRuntimeStatus = z.infer<typeof NetworkRuntimeStatusSchema>;
export type NetworkSummary = z.infer<typeof NetworkSummarySchema>;
export type NetworkListResponse = z.infer<typeof NetworkListResponseSchema>;
export type ImportNetworkRequest = z.infer<typeof ImportNetworkRequestSchema>;
export type NetworkNodeAddress = z.infer<typeof NetworkNodeAddressSchema>;
export type NetworkPeerOrganization = z.infer<typeof NetworkPeerOrganizationSchema>;
export type NetworkChannelConfiguration = z.infer<typeof NetworkChannelConfigurationSchema>;
export type RedactedNetworkConfiguration = z.infer<typeof RedactedNetworkConfigurationSchema>;
