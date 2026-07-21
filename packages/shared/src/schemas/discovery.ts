import { z } from 'zod';

import { NetworkIdSchema } from './network.js';

export const NetworkDiscoveryIdSchema = z.string().trim().min(1).max(128);

export const NetworkDiscoveryStatusSchema = z.enum([
  'configured',
  'running',
  'stopped',
  'removed',
  'unknown',
]);

export const NetworkDiscoverySummarySchema = z.object({
  peerOrganizationCount: z.number().int().nonnegative(),
  peerCount: z.number().int().nonnegative(),
  ordererCount: z.number().int().nonnegative(),
  channelCount: z.number().int().nonnegative(),
});

export const NetworkDiscoveryManifestSchema = z.object({
  schemaVersion: z.literal(1),
  networkId: NetworkDiscoveryIdSchema,
  displayName: z.string().trim().min(1).max(200),
  source: z.literal('script'),
  status: NetworkDiscoveryStatusSchema,
  workspaceRoot: z.string().min(1),
  configPath: z.string().min(1),
  composeProject: z.string().min(1),
  dockerNetwork: z.string().min(1),
  fabricVersion: z.string().min(1).nullable(),
  fabricCaVersion: z.string().min(1).nullable(),
  summary: NetworkDiscoverySummarySchema,
  updatedAt: z.string().datetime(),
});

export const NetworkDiscoveryRegistrationStatusSchema = z.enum([
  'unregistered',
  'registered',
  'conflict',
  'stale',
]);

export const NetworkDiscoveryCandidateSchema = z.object({
  manifest: NetworkDiscoveryManifestSchema,
  registrationStatus: NetworkDiscoveryRegistrationStatusSchema,
  registeredNetworkId: z.string().min(1).nullable(),
  workspaceAvailable: z.boolean(),
  configAvailable: z.boolean(),
});

export const NetworkDiscoveryListResponseSchema = z.object({
  items: z.array(NetworkDiscoveryCandidateSchema),
  total: z.number().int().nonnegative(),
  invalidManifestCount: z.number().int().nonnegative(),
});

export const ImportNetworkDiscoveryRequestSchema = z.object({
  id: NetworkIdSchema.optional(),
  displayName: z.string().trim().min(1).max(100).optional(),
});

export type NetworkDiscoveryStatus = z.infer<typeof NetworkDiscoveryStatusSchema>;
export type NetworkDiscoverySummary = z.infer<typeof NetworkDiscoverySummarySchema>;
export type NetworkDiscoveryManifest = z.infer<typeof NetworkDiscoveryManifestSchema>;
export type NetworkDiscoveryRegistrationStatus = z.infer<
  typeof NetworkDiscoveryRegistrationStatusSchema
>;
export type NetworkDiscoveryCandidate = z.infer<typeof NetworkDiscoveryCandidateSchema>;
export type NetworkDiscoveryListResponse = z.infer<typeof NetworkDiscoveryListResponseSchema>;
export type ImportNetworkDiscoveryRequest = z.infer<
  typeof ImportNetworkDiscoveryRequestSchema
>;
