import { z } from 'zod';

import { NetworkChannelConfigurationSchema, NetworkIdSchema } from './network.js';

export const NetworkNodeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'Use a valid configured container name.');

export const NetworkNodeTypeSchema = z.enum(['peer', 'orderer', 'ca']);
export const NetworkOrganizationTypeSchema = z.enum(['peer', 'orderer']);
export const NetworkEndpointKindSchema = z.enum([
  'grpc',
  'admin',
  'operations',
  'metrics',
  'ca',
]);
export const NetworkEndpointProtocolSchema = z.enum(['grpc', 'grpcs', 'http', 'https']);

export const NetworkNodeEndpointSchema = z.object({
  kind: NetworkEndpointKindSchema,
  protocol: NetworkEndpointProtocolSchema,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  internalPort: z.number().int().min(1).max(65535),
});

export const NetworkTopologyNodeSchema = z.object({
  id: NetworkNodeIdSchema,
  type: NetworkNodeTypeSchema,
  name: z.string().min(1),
  organizationId: z.string().min(1),
  organizationName: z.string().min(1),
  mspId: z.string().min(1),
  host: z.string().min(1),
  containerName: z.string().min(1),
  endpoints: z.array(NetworkNodeEndpointSchema),
});

export const NetworkTopologyOrganizationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: NetworkOrganizationTypeSchema,
  mspId: z.string().min(1),
  domain: z.string().min(1),
  nodeIds: z.array(NetworkNodeIdSchema),
});

export const NetworkTopologyResponseSchema = z.object({
  networkId: NetworkIdSchema,
  networkName: z.string().min(1),
  domain: z.string().min(1),
  dockerNetwork: z.string().min(1),
  tlsEnabled: z.boolean(),
  organizations: z.array(NetworkTopologyOrganizationSchema),
  channels: z.array(NetworkChannelConfigurationSchema),
  nodes: z.array(NetworkTopologyNodeSchema),
});

export const NetworkNodeRuntimeStateSchema = z.enum([
  'docker-unavailable',
  'missing',
  'created',
  'running',
  'paused',
  'restarting',
  'exited',
  'dead',
  'unknown',
]);

export const NetworkNodeRuntimeSchema = z.object({
  state: NetworkNodeRuntimeStateSchema,
  dockerAvailable: z.boolean(),
  containerExists: z.boolean(),
  containerRunning: z.boolean(),
  serviceReachable: z.null(),
  fabricReady: z.null(),
  status: z.string().nullable(),
  health: z.string().nullable(),
  image: z.string().nullable(),
  containerId: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  restartCount: z.number().int().nonnegative().nullable(),
  networkAttached: z.boolean().nullable(),
  ipAddress: z.string().nullable(),
  degradedReason: z.string().nullable(),
});

export const NetworkNodeSchema = NetworkTopologyNodeSchema.extend({
  runtime: NetworkNodeRuntimeSchema,
});

export const NetworkNodeListResponseSchema = z.object({
  networkId: NetworkIdSchema,
  observedAt: z.string().datetime(),
  dockerAvailable: z.boolean(),
  items: z.array(NetworkNodeSchema),
  total: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  stopped: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
});

export type NetworkNodeId = z.infer<typeof NetworkNodeIdSchema>;
export type NetworkNodeType = z.infer<typeof NetworkNodeTypeSchema>;
export type NetworkNodeEndpoint = z.infer<typeof NetworkNodeEndpointSchema>;
export type NetworkTopologyNode = z.infer<typeof NetworkTopologyNodeSchema>;
export type NetworkTopologyOrganization = z.infer<typeof NetworkTopologyOrganizationSchema>;
export type NetworkTopologyResponse = z.infer<typeof NetworkTopologyResponseSchema>;
export type NetworkNodeRuntimeState = z.infer<typeof NetworkNodeRuntimeStateSchema>;
export type NetworkNodeRuntime = z.infer<typeof NetworkNodeRuntimeSchema>;
export type NetworkNode = z.infer<typeof NetworkNodeSchema>;
export type NetworkNodeListResponse = z.infer<typeof NetworkNodeListResponseSchema>;
