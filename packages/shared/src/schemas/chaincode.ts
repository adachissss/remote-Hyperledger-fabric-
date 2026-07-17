import { z } from 'zod';

import { FabricChannelNameSchema, LedgerDecodedValueSchema } from './ledger.js';
import { NetworkIdSchema } from './network.js';

export const ChaincodeNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'Use a valid Fabric chaincode name.');

export const ChaincodeVersionSchema = z.string().trim().min(1).max(64);
export const ChaincodeLanguageSchema = z.enum(['node', 'golang', 'java']);
export const ChaincodeSequenceSchema = z.number().int().positive();
export const ChaincodeDeploymentActionSchema = z.literal('deploy');
export const ContractExecutionModeSchema = z.enum(['evaluate', 'submit']);

export const WorkspaceRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.split(/[\\/]/).includes('..'),
    'Use a path inside the registered network workspace.',
  );

export const InstalledChaincodePackageSchema = z.object({
  packageId: z.string().min(1),
  label: z.string().min(1),
  organization: z.string().min(1),
  mspId: z.string().min(1),
  observedPeer: z.string().min(1),
});

export const CommittedChaincodeDefinitionSchema = z.object({
  channelName: FabricChannelNameSchema,
  name: ChaincodeNameSchema,
  version: ChaincodeVersionSchema,
  sequence: ChaincodeSequenceSchema,
  endorsementPlugin: z.string().nullable(),
  validationPlugin: z.string().nullable(),
  validationParameterBase64: z.string(),
  approvals: z.record(z.string(), z.boolean()),
  observedPeer: z.string().min(1),
});

export const ChaincodeOrganizationSchema = z.object({
  name: z.string().min(1),
  mspId: z.string().min(1),
  observedPeer: z.string().min(1),
});

export const ChaincodeInventoryResponseSchema = z.object({
  networkId: NetworkIdSchema,
  channels: z.array(FabricChannelNameSchema),
  organizations: z.array(ChaincodeOrganizationSchema),
  installedPackages: z.array(InstalledChaincodePackageSchema),
  committedDefinitions: z.array(CommittedChaincodeDefinitionSchema),
  observedAt: z.string().datetime(),
});

export const CreateChaincodeDeploymentRequestSchema = z.object({
  channelName: FabricChannelNameSchema,
  name: ChaincodeNameSchema,
  version: ChaincodeVersionSchema,
  sequence: ChaincodeSequenceSchema,
  language: ChaincodeLanguageSchema.default('node'),
  sourcePath: WorkspaceRelativePathSchema,
  collectionsConfigPath: WorkspaceRelativePathSchema.nullable().default(null),
  signaturePolicy: z.string().trim().min(1).max(1_000).nullable().default(null),
});

export const ContractExecutionRequestSchema = z.object({
  channelName: FabricChannelNameSchema,
  chaincodeName: ChaincodeNameSchema,
  organization: z.string().trim().min(1).max(64),
  functionName: z.string().trim().min(1).max(256),
  arguments: z.array(z.string()).max(100).default([]),
  targetOrganizations: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  transient: z.record(z.string().min(1).max(128), z.string()).default({}),
});

export const ContractExecutionResultSchema = z.object({
  networkId: NetworkIdSchema,
  mode: ContractExecutionModeSchema,
  channelName: FabricChannelNameSchema,
  chaincodeName: ChaincodeNameSchema,
  organization: z.string().min(1),
  functionName: z.string().min(1),
  transactionId: z.string().nullable(),
  responseStatus: z.number().int().nullable(),
  output: LedgerDecodedValueSchema,
  durationMs: z.number().int().nonnegative(),
  completedAt: z.string().datetime(),
});

export type ChaincodeLanguage = z.infer<typeof ChaincodeLanguageSchema>;
export type ChaincodeDeploymentAction = z.infer<typeof ChaincodeDeploymentActionSchema>;
export type InstalledChaincodePackage = z.infer<typeof InstalledChaincodePackageSchema>;
export type CommittedChaincodeDefinition = z.infer<typeof CommittedChaincodeDefinitionSchema>;
export type ChaincodeOrganization = z.infer<typeof ChaincodeOrganizationSchema>;
export type ChaincodeInventoryResponse = z.infer<typeof ChaincodeInventoryResponseSchema>;
export type CreateChaincodeDeploymentRequest = z.infer<
  typeof CreateChaincodeDeploymentRequestSchema
>;
export type ContractExecutionRequest = z.infer<typeof ContractExecutionRequestSchema>;
export type ContractExecutionResult = z.infer<typeof ContractExecutionResultSchema>;
export type ContractExecutionMode = z.infer<typeof ContractExecutionModeSchema>;
