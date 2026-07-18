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

export const ManagedOrganizationNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/, 'Use lowercase letters, numbers, and hyphens.');

export const ManagedDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'Use a valid DNS domain.',
  );

export const ManagedChannelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(249)
  .regex(/^[a-z][a-z0-9.-]*$/, 'Use a valid Fabric channel name.');

export const ManagedNetworkIdSchema = NetworkIdSchema.refine((value) => value.length <= 40, {
  message: 'Managed network ids must not exceed 40 characters.',
});

export const ManagedImageTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/,
    'Use an explicit semantic version such as 2.4.1.',
  );

export const FabricStateDatabaseSchema = z.enum(['leveldb', 'couchdb']);

export const ManagedPeerOrganizationRequestSchema = z.object({
  name: ManagedOrganizationNameSchema,
  mspId: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9]*MSP$/, 'Use a valid MSP id ending in MSP.'),
  peerCount: z.number().int().min(1).max(10),
});

export const ManagedChannelRequestSchema = z.object({
  name: ManagedChannelNameSchema,
  memberOrganizations: z.array(ManagedOrganizationNameSchema).min(1).max(20),
});

export const CreateManagedNetworkRequestSchema = z
  .object({
    id: ManagedNetworkIdSchema,
    displayName: z.string().trim().min(1).max(100),
    domain: ManagedDomainSchema,
    ordererCount: z.number().int().min(1).max(7),
    peerOrganizations: z.array(ManagedPeerOrganizationRequestSchema).min(1).max(20),
    channels: z.array(ManagedChannelRequestSchema).min(1).max(20),
    preferredPortStart: z.number().int().min(10_000).max(60_000).nullable().default(null),
    fabricVersion: ManagedImageTagSchema.nullable().default(null),
    fabricCaVersion: ManagedImageTagSchema.nullable().default(null),
    stateDatabase: FabricStateDatabaseSchema.default('leveldb'),
  })
  .superRefine((value, context) => {
    const organizationNames = value.peerOrganizations.map((organization) => organization.name);
    const mspIds = value.peerOrganizations.map((organization) => organization.mspId);
    const channelNames = value.channels.map((channel) => channel.name);
    addDuplicateIssues(organizationNames, ['peerOrganizations'], 'Organization names must be unique.', context);
    addDuplicateIssues(mspIds, ['peerOrganizations'], 'MSP ids must be unique.', context);
    addDuplicateIssues(channelNames, ['channels'], 'Channel names must be unique.', context);
    const knownOrganizations = new Set(organizationNames);
    value.channels.forEach((channel, channelIndex) => {
      const members = new Set<string>();
      channel.memberOrganizations.forEach((organization, memberIndex) => {
        if (!knownOrganizations.has(organization)) {
          context.addIssue({
            code: 'custom',
            path: ['channels', channelIndex, 'memberOrganizations', memberIndex],
            message: `Unknown organization "${organization}".`,
          });
        }
        if (members.has(organization)) {
          context.addIssue({
            code: 'custom',
            path: ['channels', channelIndex, 'memberOrganizations', memberIndex],
            message: 'Channel members must be unique.',
          });
        }
        members.add(organization);
      });
    });

    const envPrefix = `pf-${value.id}`;
    const generatedHosts = [
      `${envPrefix}-orderer1.${value.domain}`,
      ...value.peerOrganizations.map(
        (organization) => `${envPrefix}-peer0.${organization.name}.${value.domain}`,
      ),
    ];
    if (generatedHosts.some((host) => !isValidDnsName(host))) {
      context.addIssue({
        code: 'custom',
        path: ['domain'],
        message: 'The domain is too long for the generated Fabric node hostnames.',
      });
    }
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
  stateDatabase: FabricStateDatabaseSchema,
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
export type ManagedPeerOrganizationRequest = z.infer<
  typeof ManagedPeerOrganizationRequestSchema
>;
export type ManagedChannelRequest = z.infer<typeof ManagedChannelRequestSchema>;
export type FabricStateDatabase = z.infer<typeof FabricStateDatabaseSchema>;
export type CreateManagedNetworkRequest = z.infer<typeof CreateManagedNetworkRequestSchema>;
export type NetworkNodeAddress = z.infer<typeof NetworkNodeAddressSchema>;
export type NetworkPeerOrganization = z.infer<typeof NetworkPeerOrganizationSchema>;
export type NetworkChannelConfiguration = z.infer<typeof NetworkChannelConfigurationSchema>;
export type RedactedNetworkConfiguration = z.infer<typeof RedactedNetworkConfigurationSchema>;

function addDuplicateIssues(
  values: string[],
  basePath: Array<string | number>,
  message: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) {
      context.addIssue({ code: 'custom', path: [...basePath, index], message });
    }
    seen.add(normalized);
  });
}

function isValidDnsName(value: string): boolean {
  return value.length <= 253 && value.split('.').every((label) => label.length >= 1 && label.length <= 63);
}
