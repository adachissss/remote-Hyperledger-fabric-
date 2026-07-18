import { z } from 'zod';

import { NetworkIdSchema } from './network.js';

export const FabricChannelNameSchema = z
  .string()
  .min(1)
  .max(249)
  .regex(/^[a-z][a-z0-9.-]*$/, 'Use a valid Fabric channel name.');

export const FabricBlockNumberSchema = z.string().regex(/^\d+$/);

export const LedgerDecodedValueSchema = z.object({
  encoding: z.enum(['empty', 'utf8', 'json', 'base64']),
  text: z.string().nullable(),
  json: z.unknown().nullable(),
  base64: z.string(),
  byteLength: z.number().int().nonnegative(),
});

export const LedgerVersionSchema = z.object({
  blockNumber: FabricBlockNumberSchema,
  transactionNumber: FabricBlockNumberSchema,
});

export const LedgerReadSchema = z.object({
  key: z.string(),
  version: LedgerVersionSchema.nullable(),
});

export const LedgerWriteSchema = z.object({
  key: z.string(),
  isDelete: z.boolean(),
  value: LedgerDecodedValueSchema,
});

export const LedgerPrivateCollectionHashSummarySchema = z.object({
  collectionName: z.string(),
  readHashCount: z.number().int().nonnegative(),
  writeHashCount: z.number().int().nonnegative(),
  metadataWriteHashCount: z.number().int().nonnegative(),
  pvtRwsetHash: z.string(),
});

export const LedgerNamespaceReadWriteSetSchema = z.object({
  namespace: z.string(),
  reads: z.array(LedgerReadSchema),
  writes: z.array(LedgerWriteSchema),
  metadataWriteCount: z.number().int().nonnegative(),
  privateCollections: z.array(LedgerPrivateCollectionHashSummarySchema),
  decodeError: z.string().nullable(),
});

export const LedgerIdentitySchema = z.object({
  mspId: z.string().nullable(),
  certificateSubject: z.string().nullable(),
});

export const LedgerEndorsementSchema = LedgerIdentitySchema.extend({
  signatureBase64: z.string(),
});

export const LedgerChaincodeEventSchema = z.object({
  chaincodeId: z.string(),
  eventName: z.string(),
  payload: LedgerDecodedValueSchema,
});

export const LedgerChaincodeActionSchema = z.object({
  chaincodeName: z.string().nullable(),
  chaincodeVersion: z.string().nullable(),
  functionName: z.string().nullable(),
  arguments: z.array(LedgerDecodedValueSchema),
  responseStatus: z.number().int().nullable(),
  responseMessage: z.string().nullable(),
  responsePayload: LedgerDecodedValueSchema.nullable(),
  endorsements: z.array(LedgerEndorsementSchema),
  readWriteSets: z.array(LedgerNamespaceReadWriteSetSchema),
  event: LedgerChaincodeEventSchema.nullable(),
  decodeError: z.string().nullable(),
});

export const LedgerTransactionSchema = z.object({
  index: z.number().int().nonnegative(),
  txId: z.string().nullable(),
  channelId: z.string().nullable(),
  type: z.number().int().nullable(),
  typeLabel: z.string(),
  timestamp: z.string().datetime().nullable(),
  creator: LedgerIdentitySchema.nullable(),
  validationCode: z.number().int(),
  validationLabel: z.string(),
  valid: z.boolean(),
  actions: z.array(LedgerChaincodeActionSchema),
  decodeError: z.string().nullable(),
});

export const LedgerBlockSummarySchema = z.object({
  number: FabricBlockNumberSchema,
  previousHash: z.string(),
  dataHash: z.string(),
  transactionCount: z.number().int().nonnegative(),
  validTransactionCount: z.number().int().nonnegative(),
  invalidTransactionCount: z.number().int().nonnegative(),
  timestamp: z.string().datetime().nullable(),
  chaincodes: z.array(z.string()),
});

export const LedgerBlockSchema = LedgerBlockSummarySchema.extend({
  networkId: NetworkIdSchema,
  channelName: FabricChannelNameSchema,
  transactions: z.array(LedgerTransactionSchema),
  rawSize: z.number().int().nonnegative(),
  decodedAt: z.string().datetime(),
});

export const LedgerChannelSchema = z.object({
  networkId: NetworkIdSchema,
  name: FabricChannelNameSchema,
  height: FabricBlockNumberSchema,
  currentBlockNumber: FabricBlockNumberSchema.nullable(),
  currentBlockHash: z.string(),
  previousBlockHash: z.string().nullable(),
  observedPeer: z.string(),
  observedAt: z.string().datetime(),
});

export const LedgerChannelListResponseSchema = z.object({
  networkId: NetworkIdSchema,
  items: z.array(LedgerChannelSchema),
  total: z.number().int().nonnegative(),
});

export const LedgerBlockListResponseSchema = z.object({
  networkId: NetworkIdSchema,
  channelName: FabricChannelNameSchema,
  height: FabricBlockNumberSchema,
  items: z.array(LedgerBlockSummarySchema),
  total: z.number().int().nonnegative(),
});

export type LedgerDecodedValue = z.infer<typeof LedgerDecodedValueSchema>;
export type LedgerNamespaceReadWriteSet = z.infer<typeof LedgerNamespaceReadWriteSetSchema>;
export type LedgerChaincodeAction = z.infer<typeof LedgerChaincodeActionSchema>;
export type LedgerTransaction = z.infer<typeof LedgerTransactionSchema>;
export type LedgerBlockSummary = z.infer<typeof LedgerBlockSummarySchema>;
export type LedgerBlock = z.infer<typeof LedgerBlockSchema>;
export type LedgerChannel = z.infer<typeof LedgerChannelSchema>;
export type LedgerChannelListResponse = z.infer<typeof LedgerChannelListResponseSchema>;
export type LedgerBlockListResponse = z.infer<typeof LedgerBlockListResponseSchema>;
