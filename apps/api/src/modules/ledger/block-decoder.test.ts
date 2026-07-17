import assert from 'node:assert/strict';
import test from 'node:test';

import fabricProtos from 'fabric-protos';

import { decodeFabricBlock, decodeLedgerValue } from './block-decoder.js';

const { common, kvrwset, msp, protos, rwset } = fabricProtos;

test('block decoder exposes chaincode arguments, endorsements and public read/write sets', () => {
  const creator = msp.SerializedIdentity.encode({
    mspid: 'Org1MSP',
    id_bytes: Buffer.from('not-a-real-certificate'),
  }).finish();
  const publicReadWriteSet = kvrwset.KVRWSet.encode({
    reads: [{ key: 'asset-1', version: { block_num: 7, tx_num: 2 } }],
    writes: [
      {
        key: 'asset-1',
        value: Buffer.from('{"owner":"alice","amount":42}'),
      },
    ],
  }).finish();
  const privateHashSet = kvrwset.HashedRWSet.encode({
    hashed_reads: [{ key_hash: Buffer.from('read-hash') }],
    hashed_writes: [
      { key_hash: Buffer.from('key-hash'), value_hash: Buffer.from('value-hash') },
    ],
  }).finish();
  const transactionReadWriteSet = rwset.TxReadWriteSet.encode({
    data_model: rwset.TxReadWriteSet.DataModel.KV,
    ns_rwset: [
      {
        namespace: 'assetcc',
        rwset: publicReadWriteSet,
        collection_hashed_rwset: [
          {
            collection_name: 'privateAssets',
            hashed_rwset: privateHashSet,
            pvt_rwset_hash: Buffer.from('private-rwset-hash'),
          },
        ],
      },
    ],
  }).finish();
  const chaincodeEvent = protos.ChaincodeEvent.encode({
    chaincode_id: 'assetcc',
    tx_id: 'tx-001',
    event_name: 'AssetCreated',
    payload: Buffer.from('{"id":"asset-1"}'),
  }).finish();
  const chaincodeAction = protos.ChaincodeAction.encode({
    results: transactionReadWriteSet,
    events: chaincodeEvent,
    response: {
      status: 200,
      message: 'OK',
      payload: Buffer.from('{"created":true}'),
    },
    chaincode_id: { name: 'assetcc', version: '1.0' },
  }).finish();
  const proposalResponsePayload = protos.ProposalResponsePayload.encode({
    proposal_hash: Buffer.from('proposal-hash'),
    extension: chaincodeAction,
  }).finish();
  const invocation = protos.ChaincodeInvocationSpec.encode({
    chaincode_spec: {
      chaincode_id: { name: 'assetcc', version: '1.0' },
      input: {
        args: [
          Buffer.from('CreateAsset'),
          Buffer.from('asset-1'),
          Buffer.from('{"owner":"alice"}'),
        ],
      },
    },
  }).finish();
  const proposalPayload = protos.ChaincodeProposalPayload.encode({
    input: invocation,
  }).finish();
  const actionPayload = protos.ChaincodeActionPayload.encode({
    chaincode_proposal_payload: proposalPayload,
    action: {
      proposal_response_payload: proposalResponsePayload,
      endorsements: [{ endorser: creator, signature: Buffer.from('signature') }],
    },
  }).finish();
  const transaction = protos.Transaction.encode({
    actions: [{ payload: actionPayload }],
  }).finish();
  const channelHeader = common.ChannelHeader.encode({
    type: common.HeaderType.ENDORSER_TRANSACTION,
    channel_id: 'mychannel',
    tx_id: 'tx-001',
    timestamp: { seconds: 1_700_000_000, nanos: 123_000_000 },
  }).finish();
  const signatureHeader = common.SignatureHeader.encode({
    creator,
    nonce: Buffer.from('nonce'),
  }).finish();
  const payload = common.Payload.encode({
    header: { channel_header: channelHeader, signature_header: signatureHeader },
    data: transaction,
  }).finish();
  const envelope = common.Envelope.encode({
    payload,
    signature: Buffer.from('envelope-signature'),
  }).finish();
  const blockBytes = common.Block.encode({
    header: {
      number: 12,
      previous_hash: Buffer.from('previous-hash'),
      data_hash: Buffer.from('data-hash'),
    },
    data: { data: [envelope] },
    metadata: {
      metadata: [new Uint8Array(), new Uint8Array(), Uint8Array.from([0])],
    },
  }).finish();

  const block = decodeFabricBlock('network-a', 'mychannel', blockBytes);

  assert.equal(block.number, '12');
  assert.equal(block.transactionCount, 1);
  assert.equal(block.validTransactionCount, 1);
  assert.deepEqual(block.chaincodes, ['assetcc']);
  const decodedTransaction = block.transactions[0];
  assert.equal(decodedTransaction?.txId, 'tx-001');
  assert.equal(decodedTransaction?.creator?.mspId, 'Org1MSP');
  assert.equal(decodedTransaction?.validationLabel, 'VALID');
  const action = decodedTransaction?.actions[0];
  assert.equal(action?.functionName, 'CreateAsset');
  assert.equal(action?.arguments[1]?.encoding, 'json');
  assert.equal(action?.endorsements[0]?.mspId, 'Org1MSP');
  assert.equal(action?.responseStatus, 200);
  assert.equal(action?.event?.eventName, 'AssetCreated');
  assert.equal(action?.readWriteSets[0]?.reads[0]?.key, 'asset-1');
  assert.deepEqual(action?.readWriteSets[0]?.writes[0]?.value.json, {
    owner: 'alice',
    amount: 42,
  });
  assert.equal(action?.readWriteSets[0]?.privateCollections[0]?.writeHashCount, 1);
});

test('ledger value decoder preserves binary bytes while exposing UTF-8 and JSON', () => {
  assert.equal(decodeLedgerValue(Buffer.from('hello')).encoding, 'utf8');
  assert.deepEqual(decodeLedgerValue(Buffer.from('{"ok":true}')).json, { ok: true });
  const binary = decodeLedgerValue(Uint8Array.from([0xff, 0x00, 0xfe]));
  assert.equal(binary.encoding, 'base64');
  assert.equal(binary.base64, '/wD+');
});
