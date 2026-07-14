'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const RSDataContract = require('../lib/rsdatacontract');

function createContext({ mspId = 'Org2MSP', transientData = null } = {}) {
    const publicState = new Map();
    const privateState = new Map();
    const transient = new Map();
    if (transientData) {
        transient.set('asset_private_data', Buffer.from(JSON.stringify(transientData)));
    }

    const ctx = {
        clientIdentity: {
            getMSPID: () => mspId,
            getID: () => 'x509::/CN=test-user'
        },
        stub: {
            getTxID: () => 'tx-pdc-test',
            getTxTimestamp: () => ({ seconds: { low: 1700000000 }, nanos: 0 }),
            getTransient: () => transient,
            getState: async key => publicState.get(key) || Buffer.alloc(0),
            putState: async (key, value) => publicState.set(key, Buffer.from(value)),
            createCompositeKey: (type, attributes) => `${type}:${attributes.join(':')}`,
            getPrivateData: async (_collection, key) => privateState.get(key) || Buffer.alloc(0),
            putPrivateData: async (_collection, key, value) => privateState.set(key, Buffer.from(value)),
            getPrivateDataHash: async (_collection, key) => {
                const value = privateState.get(key);
                return value ? crypto.createHash('sha256').update(value).digest() : Buffer.alloc(0);
            }
        }
    };

    return { ctx, publicState, privateState };
}

function publicAsset(assetId = 'ASSET_PDC_001') {
    return {
        assetId,
        level: 'L2',
        type: 'OPTICAL',
        name: 'Private remote-sensing asset',
        filehash: 'sha256:file',
        filesize: 1024,
        metadata: { resolution: '10m' }
    };
}

test('CreateAssetWithPrivateData separates public state from CID in PDC', async () => {
    const { ctx, publicState, privateState } = createContext({
        transientData: {
            assetId: 'ASSET_PDC_001',
            CID: 'bafy-private-cid',
            sensitiveMetadata: { exactFootprint: 'restricted' }
        }
    });
    const contract = new RSDataContract();
    contract._checkComplianceRemote = async () => ({ enterpriseId: 'ENT_A' });
    contract._incrementTxRemote = async () => undefined;

    const result = JSON.parse(await contract.CreateAssetWithPrivateData(
        ctx,
        JSON.stringify(publicAsset())
    ));

    const storedPublic = JSON.parse(publicState.get('ASSET_PDC_001').toString());
    const storedPrivate = JSON.parse(privateState.get('ASSET_PDC_001').toString());

    assert.equal(storedPublic.hasPrivateData, true);
    assert.equal(Object.hasOwn(storedPublic, 'CID'), false);
    assert.equal(JSON.stringify(storedPublic).includes('bafy-private-cid'), false);
    assert.equal(storedPrivate.CID, 'bafy-private-cid');
    assert.equal(storedPrivate.assetId, 'ASSET_PDC_001');
    assert.equal(result.privateDataHash, storedPublic.privateDataHash);
});

test('CreateAsset rejects CID in public arguments', async () => {
    const { ctx } = createContext();
    const contract = new RSDataContract();
    const asset = { ...publicAsset(), CID: 'must-not-be-public' };

    await assert.rejects(
        contract.CreateAsset(ctx, JSON.stringify(asset)),
        /CID 不得作为公共资产参数提交/
    );
});

test('GetAssetPrivateData checks certificate-based read permission before returning CID', async () => {
    const { ctx, publicState, privateState } = createContext();
    publicState.set('ASSET_PDC_001', Buffer.from(JSON.stringify({
        docType: 'ASSET',
        assetId: 'ASSET_PDC_001',
        hasPrivateData: true
    })));
    privateState.set('ASSET_PDC_001', Buffer.from(JSON.stringify({
        docType: 'ASSET_PRIVATE_DATA',
        assetId: 'ASSET_PDC_001',
        CID: 'bafy-private-cid',
        sensitiveMetadata: {}
    })));

    const contract = new RSDataContract();
    let permissionChecked = false;
    contract.assertReadPermission = async (_ctx, assetId) => {
        permissionChecked = true;
        assert.equal(assetId, 'ASSET_PDC_001');
    };

    const result = JSON.parse(await contract.GetAssetPrivateData(ctx, 'ASSET_PDC_001'));
    assert.equal(permissionChecked, true);
    assert.equal(result.CID, 'bafy-private-cid');
});

test('GetAssetPrivateData rejects a client outside Org1/Org2 PDC', async () => {
    const { ctx } = createContext({ mspId: 'Org3MSP' });
    const contract = new RSDataContract();

    await assert.rejects(
        contract.GetAssetPrivateData(ctx, 'ASSET_PDC_001'),
        /不是 rsAssetPrivateDataCollection 的成员/
    );
});
