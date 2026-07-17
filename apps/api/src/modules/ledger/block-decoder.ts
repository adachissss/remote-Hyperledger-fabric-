import { X509Certificate } from 'node:crypto';

import {
  LedgerBlockSchema,
  type LedgerBlock,
  type LedgerChaincodeAction,
  type LedgerDecodedValue,
  type LedgerNamespaceReadWriteSet,
  type LedgerTransaction,
} from '@plus-fabric/shared';
import fabricProtos from 'fabric-protos';

const { common, kvrwset, msp, protos, rwset } = fabricProtos;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeFabricBlock(
  networkId: string,
  channelName: string,
  bytes: Uint8Array,
): LedgerBlock {
  const block = common.Block.decode(bytes);
  const envelopes = block.data?.data ?? [];
  const validationCodes =
    block.metadata?.metadata?.[common.BlockMetadataIndex.TRANSACTIONS_FILTER] ??
    new Uint8Array();
  const transactions = envelopes.map((envelope, index) =>
    decodeEnvelope(envelope, index, validationCodes[index] ?? protos.TxValidationCode.NOT_VALIDATED),
  );
  const chaincodes = Array.from(
    new Set(
      transactions.flatMap((transaction) =>
        transaction.actions.flatMap((action) =>
          action.chaincodeName ? [action.chaincodeName] : [],
        ),
      ),
    ),
  ).sort();

  return LedgerBlockSchema.parse({
    networkId,
    channelName,
    number: uint64ToString(block.header?.number ?? 0),
    previousHash: toHex(block.header?.previous_hash),
    dataHash: toHex(block.header?.data_hash),
    transactionCount: transactions.length,
    validTransactionCount: transactions.filter((transaction) => transaction.valid).length,
    invalidTransactionCount: transactions.filter((transaction) => !transaction.valid).length,
    timestamp: transactions.find((transaction) => transaction.timestamp)?.timestamp ?? null,
    chaincodes,
    transactions,
    rawSize: bytes.byteLength,
    decodedAt: new Date().toISOString(),
  });
}

function decodeEnvelope(
  bytes: Uint8Array,
  index: number,
  validationCode: number,
): LedgerTransaction {
  const fallback = {
    index,
    txId: null,
    channelId: null,
    type: null,
    typeLabel: 'UNKNOWN',
    timestamp: null,
    creator: null,
    validationCode,
    validationLabel: enumLabel(protos.TxValidationCode, validationCode, 'UNKNOWN'),
    valid: validationCode === protos.TxValidationCode.VALID,
    actions: [],
  };

  try {
    const envelope = common.Envelope.decode(bytes);
    const payload = common.Payload.decode(envelope.payload);
    const channelHeader = payload.header?.channel_header?.length
      ? common.ChannelHeader.decode(payload.header.channel_header)
      : null;
    const signatureHeader = payload.header?.signature_header?.length
      ? common.SignatureHeader.decode(payload.header.signature_header)
      : null;
    const type = channelHeader?.type ?? null;
    const actions =
      type === common.HeaderType.ENDORSER_TRANSACTION
        ? protos.Transaction.decode(payload.data).actions.map((action) =>
            decodeChaincodeAction(action.payload ?? new Uint8Array()),
          )
        : [];

    return {
      ...fallback,
      txId: channelHeader?.tx_id || null,
      channelId: channelHeader?.channel_id || null,
      type,
      typeLabel: type === null ? 'UNKNOWN' : enumLabel(common.HeaderType, type, 'UNKNOWN'),
      timestamp: timestampToIso(channelHeader?.timestamp),
      creator: signatureHeader?.creator?.length
        ? decodeIdentity(signatureHeader.creator)
        : null,
      actions,
      decodeError: null,
    };
  } catch (error) {
    return {
      ...fallback,
      decodeError: errorMessage(error),
    };
  }
}

function decodeChaincodeAction(bytes: Uint8Array): LedgerChaincodeAction {
  const fallback: LedgerChaincodeAction = {
    chaincodeName: null,
    chaincodeVersion: null,
    functionName: null,
    arguments: [],
    responseStatus: null,
    responseMessage: null,
    responsePayload: null,
    endorsements: [],
    readWriteSets: [],
    event: null,
    decodeError: null,
  };

  try {
    const actionPayload = protos.ChaincodeActionPayload.decode(bytes);
    const proposalPayload = protos.ChaincodeProposalPayload.decode(
      actionPayload.chaincode_proposal_payload,
    );
    const invocation = protos.ChaincodeInvocationSpec.decode(proposalPayload.input);
    const argumentBytes = invocation.chaincode_spec?.input?.args ?? [];
    const responsePayload = protos.ProposalResponsePayload.decode(
      actionPayload.action?.proposal_response_payload ?? new Uint8Array(),
    );
    const chaincodeAction = protos.ChaincodeAction.decode(responsePayload.extension);
    const chaincodeId =
      chaincodeAction.chaincode_id ?? invocation.chaincode_spec?.chaincode_id ?? null;

    return {
      chaincodeName: chaincodeId?.name || null,
      chaincodeVersion: chaincodeId?.version || null,
      functionName: argumentBytes[0]?.length
        ? decodeLedgerValue(argumentBytes[0]).text
        : null,
      arguments: argumentBytes.slice(1).map(decodeLedgerValue),
      responseStatus: chaincodeAction.response?.status ?? null,
      responseMessage: chaincodeAction.response?.message || null,
      responsePayload: chaincodeAction.response
        ? decodeLedgerValue(chaincodeAction.response.payload ?? new Uint8Array())
        : null,
      endorsements: (actionPayload.action?.endorsements ?? []).map((endorsement) => ({
        ...decodeIdentity(endorsement.endorser ?? new Uint8Array()),
        signatureBase64: toBase64(endorsement.signature),
      })),
      readWriteSets: chaincodeAction.results?.length
        ? decodeReadWriteSets(chaincodeAction.results)
        : [],
      event: chaincodeAction.events?.length
        ? decodeChaincodeEvent(chaincodeAction.events)
        : null,
      decodeError: null,
    };
  } catch (error) {
    return { ...fallback, decodeError: errorMessage(error) };
  }
}

function decodeReadWriteSets(bytes: Uint8Array): LedgerNamespaceReadWriteSet[] {
  const transactionReadWriteSet = rwset.TxReadWriteSet.decode(bytes);
  return (transactionReadWriteSet.ns_rwset ?? []).map((namespace) => {
    let decoded: ReturnType<typeof kvrwset.KVRWSet.decode> | null = null;
    let decodeError: string | null = null;
    try {
      decoded = kvrwset.KVRWSet.decode(namespace.rwset ?? new Uint8Array());
    } catch (error) {
      decodeError = errorMessage(error);
    }

    return {
      namespace: namespace.namespace ?? '',
      reads: (decoded?.reads ?? []).map((read) => ({
        key: read.key ?? '',
        version: read.version
          ? {
              blockNumber: uint64ToString(read.version.block_num),
              transactionNumber: uint64ToString(read.version.tx_num),
            }
          : null,
      })),
      writes: (decoded?.writes ?? []).map((write) => ({
        key: write.key ?? '',
        isDelete: write.is_delete ?? false,
        value: decodeLedgerValue(write.value ?? new Uint8Array()),
      })),
      metadataWriteCount: decoded?.metadata_writes.length ?? 0,
      privateCollections: (namespace.collection_hashed_rwset ?? []).map((collection) => {
        let hashedReadWriteSet;
        try {
          hashedReadWriteSet = kvrwset.HashedRWSet.decode(
            collection.hashed_rwset ?? new Uint8Array(),
          );
        } catch {
          hashedReadWriteSet = null;
        }
        return {
          collectionName: collection.collection_name ?? '',
          readHashCount: hashedReadWriteSet?.hashed_reads.length ?? 0,
          writeHashCount: hashedReadWriteSet?.hashed_writes.length ?? 0,
          metadataWriteHashCount: hashedReadWriteSet?.metadata_writes.length ?? 0,
          pvtRwsetHash: toHex(collection.pvt_rwset_hash),
        };
      }),
      decodeError,
    };
  });
}

function decodeChaincodeEvent(bytes: Uint8Array) {
  const event = protos.ChaincodeEvent.decode(bytes);
  return {
    chaincodeId: event.chaincode_id,
    eventName: event.event_name,
    payload: decodeLedgerValue(event.payload),
  };
}

function decodeIdentity(bytes: Uint8Array) {
  try {
    const identity = msp.SerializedIdentity.decode(bytes);
    let certificateSubject: string | null = null;
    try {
      certificateSubject = new X509Certificate(identity.id_bytes).subject;
    } catch {
      certificateSubject = null;
    }
    return {
      mspId: identity.mspid || null,
      certificateSubject,
    };
  } catch {
    return { mspId: null, certificateSubject: null };
  }
}

export function decodeLedgerValue(bytes: Uint8Array): LedgerDecodedValue {
  const buffer = Buffer.from(bytes);
  const base64 = buffer.toString('base64');
  if (buffer.length === 0) {
    return { encoding: 'empty', text: '', json: null, base64, byteLength: 0 };
  }

  try {
    const text = utf8Decoder.decode(buffer);
    try {
      return {
        encoding: 'json',
        text,
        json: JSON.parse(text) as unknown,
        base64,
        byteLength: buffer.length,
      };
    } catch {
      return { encoding: 'utf8', text, json: null, base64, byteLength: buffer.length };
    }
  } catch {
    return { encoding: 'base64', text: null, json: null, base64, byteLength: buffer.length };
  }
}

function timestampToIso(timestamp: { seconds?: unknown; nanos?: number | null } | null | undefined) {
  if (!timestamp?.seconds) return null;
  const seconds = Number(String(timestamp.seconds));
  if (!Number.isFinite(seconds)) return null;
  const milliseconds = seconds * 1_000 + Math.floor((timestamp.nanos ?? 0) / 1_000_000);
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function uint64ToString(value: unknown): string {
  return String(value ?? 0);
}

function enumLabel(
  values: Record<number, string>,
  value: number,
  fallback: string,
): string {
  return values[value] ?? fallback;
}

function toHex(bytes: Uint8Array | null | undefined): string {
  return Buffer.from(bytes ?? []).toString('hex');
}

function toBase64(bytes: Uint8Array | null | undefined): string {
  return Buffer.from(bytes ?? []).toString('base64');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown protobuf decoding error.';
}
