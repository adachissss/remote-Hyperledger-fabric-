import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ChaincodeInventoryResponseSchema,
  ContractExecutionResultSchema,
  HealthResponseSchema,
  JobEventListResponseSchema,
  JobListResponseSchema,
  JobSchema,
  LedgerBlockListResponseSchema,
  LedgerBlockSchema,
  LedgerChannelListResponseSchema,
  NetworkListResponseSchema,
  NetworkNodeListResponseSchema,
  NetworkNodeSchema,
  NetworkTopologyResponseSchema,
} from '@plus-fabric/shared';
import fabricProtos from 'fabric-protos';

import { buildApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import type { DockerRuntime } from './modules/networks/docker-runtime.js';
import { TcpServiceProbe, type ServiceProbe } from './modules/networks/service-probe.js';
import type { ProcessRunner } from './modules/jobs/process-runner.js';
import {
  parseBlockchainInfo,
  type FabricLedgerRuntime,
} from './modules/ledger/fabric-ledger-runtime.js';
import type { FabricChaincodeRuntime } from './modules/chaincodes/fabric-chaincode-runtime.js';
import type { HostPortProbe } from './modules/networks/managed-port-planner.js';
import {
  isMissingDockerObjectError,
  type ManagedNamespaceProbe,
} from './modules/networks/managed-network-service.js';

function createTestConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    CONTROL_PLANE_LOG_LEVEL: 'silent',
    CONTROL_PLANE_DATABASE_PATH: ':memory:',
    ...overrides,
  });
}

const observableDockerRuntime: DockerRuntime = {
  async probe() {
    return { available: true, reason: null };
  },
  async inspectContainer(containerName, expectedNetwork) {
    if (containerName !== 'orderer1.network-a.test') return null;
    return {
      containerId: 'orderer-container-id',
      status: 'running',
      running: true,
      paused: false,
      restarting: false,
      health: 'healthy',
      image: 'hyperledger/fabric-orderer:3.1.4',
      startedAt: '2026-07-15T10:00:00.000000000Z',
      finishedAt: null,
      restartCount: 0,
      networkAttached: expectedNetwork === 'network-a-docker',
      ipAddress: '172.20.0.2',
    };
  },
};

const unavailableDockerRuntime: DockerRuntime = {
  async probe() {
    return { available: false, reason: 'Docker is unavailable in this test.' };
  },
  async inspectContainer() {
    throw new Error('inspect must not run when Docker is unavailable');
  },
};

const reachableServiceProbe: ServiceProbe = {
  async probe(target) {
    assert.equal(target.host, '127.0.0.1');
    assert.equal(target.timeoutMs, 1_500);
    return { reachable: true, latencyMs: 2 };
  },
};

const unreachableServiceProbe: ServiceProbe = {
  async probe() {
    return { reachable: false, latencyMs: null };
  },
};

const successfulProcessRunner: ProcessRunner = {
  async run(request) {
    assert.equal(request.environment.COMPOSE_PROJECT_NAME, 'network_a');
    if (request.executable.endsWith('network.sh')) {
      assert.deepEqual(request.args, ['restart']);
      await request.onLine({ stream: 'stdout', message: 'network restart completed' });
    } else {
      assert(request.executable.endsWith('upgrade_chaincode.sh'));
      assert(request.args.includes('--name'));
      assert(request.args.includes('assetcc'));
      await request.onLine({ stream: 'stdout', message: 'chaincode deployment completed' });
    }
    return { exitCode: 0, signal: null, cancelled: false, timedOut: false };
  },
};

const observableLedgerRuntime: FabricLedgerRuntime = {
  async listChannels(peer) {
    assert.equal(peer.mspId, 'Org1MSP');
    assert.equal(peer.address, 'peer0.org1.network-a.test:7051');
    return ['channel-a'];
  },
  async getChannelInfo(_peer, channelName) {
    assert.equal(channelName, 'channel-a');
    return {
      height: '13',
      currentBlockHash: 'current-block-hash',
      previousBlockHash: 'previous-block-hash',
    };
  },
  async fetchBlock(_peer, channelName, blockNumber) {
    assert.equal(channelName, 'channel-a');
    return fabricProtos.common.Block.encode({
      header: {
        number: Number(blockNumber),
        previous_hash: Buffer.from(`previous-${blockNumber}`),
        data_hash: Buffer.from(`data-${blockNumber}`),
      },
      data: { data: [] },
      metadata: { metadata: [] },
    }).finish();
  },
};

const observableChaincodeRuntime: FabricChaincodeRuntime = {
  async queryInstalled(peer) {
    assert.equal(peer.organizationName, 'org1');
    return [{ packageId: 'assetcc_1.0:package-hash', label: 'assetcc_1.0' }];
  },
  async queryCommitted(peer, channelName) {
    assert.equal(peer.mspId, 'Org1MSP');
    assert.equal(channelName, 'channel-a');
    return [
      {
        name: 'assetcc',
        version: '1.0',
        sequence: 1,
        endorsementPlugin: 'escc',
        validationPlugin: 'vscc',
        validationParameterBase64: 'cG9saWN5',
        approvals: { Org1MSP: true },
      },
    ];
  },
  async executeContract(input) {
    assert.equal(input.request.chaincodeName, 'assetcc');
    assert.equal(input.invokingPeer.organizationName, 'org1');
    return {
      transactionId: input.mode === 'submit' ? 'a'.repeat(64) : null,
      responseStatus: 200,
      output: Buffer.from('{"ok":true}'),
    };
  },
};

const availableHostPortProbe: HostPortProbe = {
  async isAvailable() {
    return true;
  },
};

const availableManagedNamespaceProbe: ManagedNamespaceProbe = {
  async assertAvailable(dockerNetwork, containerNames) {
    assert.match(dockerNetwork, /^pf-managed-(?:network|race)$/);
    assert.equal(new Set(containerNames).size, containerNames.length);
  },
};

test('health endpoint exposes a valid control-plane heartbeat', async () => {
  const app = await buildApp(createTestConfig());

  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/system/health' });
    assert.equal(response.statusCode, 200);

    const payload = HealthResponseSchema.parse(response.json());
    assert.equal(payload.status, 'ok');
    assert.equal(payload.service, 'plus-fabric-control-plane');
  } finally {
    await app.close();
  }
});

test('network registry starts empty and never infers a local instance', async () => {
  const app = await buildApp(createTestConfig());

  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/networks' });
    assert.equal(response.statusCode, 200);

    const payload = NetworkListResponseSchema.parse(response.json());
    assert.deepEqual(payload, { items: [], total: 0 });
  } finally {
    await app.close();
  }
});

test('unknown routes return a stable JSON error', async () => {
  const app = await buildApp(createTestConfig());

  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/unknown' });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      error: 'not_found',
      message: 'The requested control-plane resource does not exist.',
    });
  } finally {
    await app.close();
  }
});

test('invalid environment configuration fails before the server starts', () => {
  assert.throws(() => loadConfig({ CONTROL_PLANE_PORT: 'not-a-port' }));
});

test('TCP service probe distinguishes reachable and closed ports', async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');

  const probe = new TcpServiceProbe();
  const reachable = await probe.probe({
    host: '127.0.0.1',
    port: address.port,
    timeoutMs: 500,
  });
  assert.equal(reachable.reachable, true);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  const unreachable = await probe.probe({
    host: '127.0.0.1',
    port: address.port,
    timeoutMs: 500,
  });
  assert.equal(unreachable.reachable, false);
});

test('Docker namespace probing recognizes missing object message variants', () => {
  assert.equal(
    isMissingDockerObjectError('Error response from daemon: network pf-alpha not found'),
    true,
  );
  assert.equal(
    isMissingDockerObjectError('Error response from daemon: No such container: pf-alpha-peer0'),
    true,
  );
  assert.equal(isMissingDockerObjectError('Cannot connect to the Docker daemon'), false);
});

test('Fabric blockchain info accepts a missing genesis previous hash', () => {
  assert.deepEqual(
    parseBlockchainInfo(
      'Blockchain info: {"height":1,"currentBlockHash":"current-hash"}',
      'genesis-channel',
    ),
    {
      height: '1',
      currentBlockHash: 'current-hash',
      previousBlockHash: null,
    },
  );
});

test('network import is disabled until an administrator allows workspace roots', async () => {
  const app = await buildApp(createTestConfig());

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/networks/import',
      payload: {
        id: 'network-a',
        displayName: 'Network A',
        driver: 'fabric-compose',
        workspaceRoot: '/tmp/network-a',
        configPath: 'config/orgs.yaml',
        composeProject: 'network_a',
      },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'network_import_disabled');
  } finally {
    await app.close();
  }
});

test('network deletion cleans managed registrations while preserving imported workspaces', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'plus-fabric-delete-'));
  const managedNetworkRoot = path.join(temporaryRoot, 'managed-networks');
  const importedWorkspace = path.join(temporaryRoot, 'imported-network');
  mkdirSync(path.join(importedWorkspace, 'config'), { recursive: true });
  writeFileSync(
    path.join(importedWorkspace, 'config', 'orgs.yaml'),
    `
network:
  name: imported-delete-docker
  domain: imported-delete.test
  tls_enabled: true
ordererOrg:
  mspid: OrdererMSP
  domain: imported-delete.test
  ca_url: https://localhost:39054
  ca_name: ca-orderer
  nodes:
    - name: orderer1
      host: orderer1.imported-delete.test
      port: 39050
peerOrgs:
  - name: org1
    mspid: Org1MSP
    domain: org1.imported-delete.test
    ca_url: https://localhost:39154
    ca_name: ca-org1
    peer_count: 1
    anchor_peers:
      - host: peer0.org1.imported-delete.test
        port: 39151
channels:
  - name: delete-channel
    profile: ApplicationChannel
    memberOrgs: [org1]
`,
  );
  writeFileSync(path.join(importedWorkspace, 'network.sh'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(path.join(importedWorkspace, 'network.sh'), 0o755);

  const deletionCalls: Array<{ args: string[]; environment: Record<string, string> }> = [];
  const deletionProcessRunner: ProcessRunner = {
    async run(request) {
      deletionCalls.push({ args: request.args, environment: request.environment });
      assert.equal(request.environment.REMOVE_CHAINCODE_IMAGES_ON_DOWN, 'true');
      if (request.args[0] === 'cleanup-docker') {
        assert.equal(request.environment.ALLOW_EXTERNAL_CONFIG_FILE, 'true');
        assert.equal(request.environment.REMOVE_DOCKER_NETWORK_ON_DOWN, 'true');
        await request.onLine({ stream: 'stdout', message: 'target Docker namespace verified' });
        return { exitCode: 0, signal: null, cancelled: false, timedOut: false };
      }
      assert.deepEqual(request.args, ['down']);
      await request.onLine({ stream: 'stdout', message: 'target network resources removed' });
      return {
        exitCode: request.environment.COMPOSE_PROJECT_NAME === 'pf_managed_failure' ? 1 : 0,
        signal: null,
        cancelled: false,
        timedOut: false,
      };
    },
  };
  const config = createTestConfig({
    CONTROL_PLANE_ALLOWED_NETWORK_ROOTS: temporaryRoot,
    CONTROL_PLANE_DATABASE_PATH: path.join(temporaryRoot, 'control-plane.sqlite'),
    CONTROL_PLANE_MANAGED_NETWORK_ROOT: managedNetworkRoot,
  });
  const app = await buildApp(config, {
    processRunner: deletionProcessRunner,
    hostPortProbe: availableHostPortProbe,
    managedNamespaceProbe: { async assertAvailable() {} },
  });

  try {
    const managedCreateResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/networks',
      payload: {
        id: 'managed-delete',
        displayName: 'Managed Delete',
        domain: 'managed-delete.test',
        ordererCount: 1,
        peerOrganizations: [{ name: 'org1', mspId: 'Org1MSP', peerCount: 1 }],
        channels: [{ name: 'delete-channel', memberOrganizations: ['org1'] }],
        preferredPortStart: 34_000,
      },
    });
    assert.equal(managedCreateResponse.statusCode, 201, managedCreateResponse.body);
    const managedWorkspace = path.join(managedNetworkRoot, 'managed-delete');
    assert.equal(existsSync(managedWorkspace), true);

    const unsafeDeleteResponse = await app.inject({
      method: 'DELETE',
      url: '/api/v1/networks/managed-delete',
      payload: {},
    });
    assert.equal(unsafeDeleteResponse.statusCode, 400);
    assert.equal(unsafeDeleteResponse.json().error, 'network_confirmation_required');

    const managedDeleteResponse = await app.inject({
      method: 'DELETE',
      url: '/api/v1/networks/managed-delete',
      payload: { confirmation: 'managed-delete' },
    });
    assert.equal(managedDeleteResponse.statusCode, 202);
    const managedDeleteJob = JobSchema.parse(managedDeleteResponse.json());
    assert.equal(managedDeleteJob.action, 'delete');
    await waitForJob(app, managedDeleteJob.id, 'succeeded');
    assert.equal(existsSync(managedWorkspace), false);

    const afterManagedDelete = NetworkListResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/networks' })).json(),
    );
    assert.equal(afterManagedDelete.total, 0);

    const replacementResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/networks',
      payload: {
        id: 'managed-replacement',
        displayName: 'Managed Replacement',
        domain: 'managed-replacement.test',
        ordererCount: 1,
        peerOrganizations: [{ name: 'org1', mspId: 'Org1MSP', peerCount: 1 }],
        channels: [{ name: 'delete-channel', memberOrganizations: ['org1'] }],
        preferredPortStart: 34_000,
      },
    });
    assert.equal(replacementResponse.statusCode, 201, replacementResponse.body);

    const importResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/networks/import',
      payload: {
        id: 'imported-delete',
        displayName: 'Imported Delete',
        driver: 'fabric-compose',
        workspaceRoot: importedWorkspace,
        configPath: 'config/orgs.yaml',
        composeProject: 'imported_delete',
      },
    });
    assert.equal(importResponse.statusCode, 201, importResponse.body);

    const importedDeleteResponse = await app.inject({
      method: 'DELETE',
      url: '/api/v1/networks/imported-delete',
      payload: { confirmation: 'imported-delete' },
    });
    const importedDeleteJob = JobSchema.parse(importedDeleteResponse.json());
    await waitForJob(app, importedDeleteJob.id, 'succeeded');
    assert.equal(existsSync(importedWorkspace), true);
    assert.equal(deletionCalls.length, 4);

    const importedEvents = JobEventListResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/jobs/${importedDeleteJob.id}/events`,
        })
      ).json(),
    );
    assert(
      importedEvents.items.some((event) => event.message === '导入网络的外部工作区已保留。'),
    );

    const failingCreateResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/networks',
      payload: {
        id: 'managed-failure',
        displayName: 'Managed Failure',
        domain: 'managed-failure.test',
        ordererCount: 1,
        peerOrganizations: [{ name: 'org1', mspId: 'Org1MSP', peerCount: 1 }],
        channels: [{ name: 'failure-channel', memberOrganizations: ['org1'] }],
        preferredPortStart: 35_000,
      },
    });
    assert.equal(failingCreateResponse.statusCode, 201, failingCreateResponse.body);
    const failingWorkspace = path.join(managedNetworkRoot, 'managed-failure');
    const failingDeleteResponse = await app.inject({
      method: 'DELETE',
      url: '/api/v1/networks/managed-failure',
      payload: { confirmation: 'managed-failure' },
    });
    const failingDeleteJob = JobSchema.parse(failingDeleteResponse.json());
    await waitForJob(app, failingDeleteJob.id, 'failed');
    assert.equal(existsSync(failingWorkspace), true);
    const afterFailedDelete = NetworkListResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/networks' })).json(),
    );
    assert(afterFailedDelete.items.some((network) => network.id === 'managed-failure'));
    assert.equal(deletionCalls.length, 5);
  } finally {
    await app.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('an allowed Fabric workspace can be imported and read back without secrets', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'plus-fabric-registry-'));
  const workspaceRoot = path.join(temporaryRoot, 'network-a');
  const configDirectory = path.join(workspaceRoot, 'config');
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    path.join(configDirectory, 'orgs.yaml'),
    `
network:
  name: network-a-docker
  domain: network-a.test
  tls_enabled: true
ordererOrg:
  mspid: OrdererMSP
  domain: network-a.test
  ca_url: https://localhost:10054
  ca_name: ca-orderer
  admin_password: never-return-this
  nodes:
    - name: orderer1
      host: orderer1.network-a.test
      port: 7050
peerOrgs:
  - name: org1
    mspid: Org1MSP
    domain: org1.network-a.test
    ca_url: https://localhost:7054
    ca_name: ca-org1
    admin_password: never-return-this-either
    peer_count: 1
    anchor_peers:
      - name: peer0
        host: peer0.org1.network-a.test
        port: 7051
channels:
  - name: channel-a
    profile: ApplicationChannel
    memberOrgs: [org1]
`,
  );
  writeFileSync(path.join(workspaceRoot, 'network.sh'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(path.join(workspaceRoot, 'network.sh'), 0o755);
  writeFileSync(
    path.join(workspaceRoot, 'upgrade_chaincode.sh'),
    '#!/usr/bin/env bash\nexit 0\n',
  );
  chmodSync(path.join(workspaceRoot, 'upgrade_chaincode.sh'), 0o755);
  mkdirSync(path.join(workspaceRoot, 'chaincode', 'assetcc'), { recursive: true });
  const peerExecutable = path.join(workspaceRoot, 'bin', 'peer');
  mkdirSync(path.dirname(peerExecutable), { recursive: true });
  writeFileSync(peerExecutable, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(peerExecutable, 0o755);
  const identityDomain = 'network-a-docker-org1.network-a.test';
  const peerHost = 'peer0.org1.network-a.test';
  const peerRoot = path.join(
    workspaceRoot,
    'organizations',
    'peerOrganizations',
    identityDomain,
  );
  mkdirSync(path.join(peerRoot, 'users', `Admin@${identityDomain}`, 'msp'), {
    recursive: true,
  });
  mkdirSync(path.join(peerRoot, 'peers', peerHost, 'tls'), { recursive: true });
  writeFileSync(path.join(peerRoot, 'peers', peerHost, 'tls', 'ca.crt'), 'test-ca');
  writeFileSync(path.join(peerRoot, 'peers', peerHost, 'core.yaml'), 'peer: {}\n');
  const ordererTlsDirectory = path.join(
    workspaceRoot,
    'organizations',
    'ordererOrganizations',
    'network-a.test',
    'orderers',
    'orderer1.network-a.test',
    'tls',
  );
  mkdirSync(ordererTlsDirectory, { recursive: true });
  writeFileSync(path.join(ordererTlsDirectory, 'ca.crt'), 'test-orderer-ca');

  const config = createTestConfig({
    CONTROL_PLANE_ALLOWED_NETWORK_ROOTS: temporaryRoot,
    CONTROL_PLANE_DATABASE_PATH: path.join(temporaryRoot, 'control-plane.sqlite'),
    CONTROL_PLANE_MANAGED_NETWORK_ROOT: path.join(temporaryRoot, 'managed-networks'),
  });

  try {
    const app = await buildApp(config, {
      dockerRuntime: observableDockerRuntime,
      serviceProbe: reachableServiceProbe,
      processRunner: successfulProcessRunner,
      ledgerRuntime: observableLedgerRuntime,
      chaincodeRuntime: observableChaincodeRuntime,
      hostPortProbe: availableHostPortProbe,
      managedNamespaceProbe: availableManagedNamespaceProbe,
    });
    try {
      const importResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks/import',
        payload: {
          id: 'network-a',
          displayName: 'Network A',
          driver: 'fabric-compose',
          workspaceRoot,
          configPath: 'config/orgs.yaml',
          composeProject: 'network_a',
          fabricVersion: '3.1.4',
          fabricCaVersion: '1.5.19',
        },
      });

      assert.equal(importResponse.statusCode, 201);
      assert.deepEqual(importResponse.json(), {
        id: 'network-a',
        displayName: 'Network A',
        driver: 'fabric-compose',
        managementMode: 'imported',
        status: 'unknown',
        fabricVersion: '3.1.4',
        organizationCount: 1,
        channelCount: 1,
        nodeCount: 4,
        updatedAt: importResponse.json().updatedAt,
      });

      const listResponse = await app.inject({ method: 'GET', url: '/api/v1/networks' });
      assert.equal(listResponse.statusCode, 200);
      assert.equal(listResponse.json().total, 1);

      const configResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/networks/network-a/config',
      });
      assert.equal(configResponse.statusCode, 200);
      assert.equal(configResponse.json().networkName, 'network-a-docker');
      assert.equal(configResponse.json().stateDatabase, 'leveldb');
      assert.deepEqual(configResponse.json().ordererConfiguration, {
        consensusType: 'etcdraft',
        batchTimeoutSeconds: 2,
        maxMessageCount: 10,
        absoluteMaxBytesMiB: 99,
        preferredMaxBytesKiB: 512,
      });
      assert.equal(configResponse.json().channels[0].name, 'channel-a');
      assert.doesNotMatch(configResponse.body, /never-return-this/);

      const topologyResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/networks/network-a/topology',
      });
      assert.equal(topologyResponse.statusCode, 200);
      const topology = NetworkTopologyResponseSchema.parse(topologyResponse.json());
      assert.equal(topology.organizations.length, 2);
      assert.equal(topology.nodes.length, 4);
      assert.deepEqual(
        topology.nodes.map((node) => node.type).sort(),
        ['ca', 'ca', 'orderer', 'peer'],
      );

      const channelsResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/networks/network-a/channels',
      });
      assert.equal(channelsResponse.statusCode, 200);
      const channels = LedgerChannelListResponseSchema.parse(channelsResponse.json());
      assert.equal(channels.items[0]?.name, 'channel-a');
      assert.equal(channels.items[0]?.height, '13');
      assert.equal(channels.items[0]?.currentBlockNumber, '12');

      const blocksResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/networks/network-a/channels/channel-a/blocks?limit=2',
      });
      const blocks = LedgerBlockListResponseSchema.parse(blocksResponse.json());
      assert.deepEqual(blocks.items.map((block) => block.number), ['12', '11']);

      const blockResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/networks/network-a/channels/channel-a/blocks/12',
      });
      const block = LedgerBlockSchema.parse(blockResponse.json());
      assert.equal(block.number, '12');
      assert.equal(block.dataHash, Buffer.from('data-12').toString('hex'));

      const nodesResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/networks/network-a/nodes',
      });
      assert.equal(nodesResponse.statusCode, 200);
      const nodes = NetworkNodeListResponseSchema.parse(nodesResponse.json());
      assert.equal(nodes.total, 4);
      assert.equal(nodes.running, 1);
      assert.equal(nodes.missing, 3);
      assert.equal(nodes.dockerAvailable, true);
      assert.equal(nodes.reachable, 1);
      assert.equal(nodes.unreachable, 3);

      const nodeResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/networks/network-a/nodes/orderer1.network-a.test',
      });
      assert.equal(nodeResponse.statusCode, 200);
      const orderer = NetworkNodeSchema.parse(nodeResponse.json());
      assert.equal(orderer.runtime.state, 'running');
      assert.equal(orderer.runtime.serviceReachable, true);
      assert.equal(orderer.runtime.networkAttached, true);
      assert.equal(orderer.runtime.ipAddress, '172.20.0.2');

      const unknownNodeResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/networks/network-a/nodes/unknown-node',
      });
      assert.equal(unknownNodeResponse.statusCode, 404);
      assert.equal(unknownNodeResponse.json().error, 'node_not_found');

      const duplicateResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks/import',
        payload: {
          id: 'network-a',
          displayName: 'Network A duplicate',
          driver: 'fabric-compose',
          workspaceRoot,
          configPath: 'config/orgs.yaml',
          composeProject: 'network_a_duplicate',
        },
      });
      assert.equal(duplicateResponse.statusCode, 409);

      const concurrentWorkspaceRoot = path.join(temporaryRoot, 'network-b');
      mkdirSync(path.join(concurrentWorkspaceRoot, 'config'), { recursive: true });
      writeFileSync(
        path.join(concurrentWorkspaceRoot, 'config', 'orgs.yaml'),
        readFileSync(path.join(configDirectory, 'orgs.yaml'), 'utf8')
          .replaceAll('network-a', 'network-b')
          .replace('10054', '11054')
          .replace('7054', '8054')
          .replace('port: 7050', 'port: 8050\n      admin_port: 8053\n      operations_port: 10443')
          .replace(
            '    peer_count: 1',
            '    peer_count: 1\n    peers:\n      - name: peer0\n        peer_port: 8051\n        chaincode_port: 8052\n        metrics_port: 8055',
          )
          .replace('port: 7051', 'port: 8051'),
      );
      const concurrentPayload = {
        id: 'network-b',
        displayName: 'Network B',
        driver: 'fabric-compose',
        workspaceRoot: concurrentWorkspaceRoot,
        configPath: 'config/orgs.yaml',
        composeProject: 'network_b',
      };
      const concurrentResponses = await Promise.all([
        app.inject({ method: 'POST', url: '/api/v1/networks/import', payload: concurrentPayload }),
        app.inject({ method: 'POST', url: '/api/v1/networks/import', payload: concurrentPayload }),
      ]);
      assert.deepEqual(
        concurrentResponses.map((response) => response.statusCode).sort(),
        [201, 409],
      );
      assert.equal(
        concurrentResponses.find((response) => response.statusCode === 409)?.json().error,
        'network_exists',
      );

      const namespaceConflictResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks/import',
        payload: {
          id: 'network-c',
          displayName: 'Network C',
          driver: 'fabric-compose',
          workspaceRoot,
          configPath: 'config/orgs.yaml',
          composeProject: 'network_c',
        },
      });
      assert.equal(namespaceConflictResponse.statusCode, 409);
      assert.equal(namespaceConflictResponse.json().error, 'network_namespace_conflict');

      const concurrentManagedPayload = {
        id: 'managed-race',
        displayName: 'Managed Race',
        domain: 'managed-race.test',
        ordererCount: 1,
        peerOrganizations: [{ name: 'alpha', mspId: 'AlphaMSP', peerCount: 1 }],
        channels: [{ name: 'race-channel', memberOrganizations: ['alpha'] }],
        preferredPortStart: 32_000,
      };
      const concurrentManagedResponses = await Promise.all([
        app.inject({ method: 'POST', url: '/api/v1/networks', payload: concurrentManagedPayload }),
        app.inject({ method: 'POST', url: '/api/v1/networks', payload: concurrentManagedPayload }),
      ]);
      assert.deepEqual(
        concurrentManagedResponses.map((response) => response.statusCode).sort(),
        [201, 409],
        concurrentManagedResponses.map((response) => response.body).join('\n'),
      );
      assert.equal(
        concurrentManagedResponses.find((response) => response.statusCode === 409)?.json().error,
        'network_exists',
      );
      assert.equal(
        concurrentManagedResponses.find((response) => response.statusCode === 201)?.json()
          .fabricVersion,
        '2.4.1',
      );
      const defaultManagedConfig = readFileSync(
        path.join(
          temporaryRoot,
          'managed-networks',
          'managed-race',
          'config',
          'orgs.yaml',
        ),
        'utf8',
      );
      assert.match(defaultManagedConfig, /fabric_version: 2\.4\.1/);
      assert.match(defaultManagedConfig, /fabric_ca_version: 1\.5\.3/);
      assert.match(defaultManagedConfig, /remove_docker_network_on_down: true/);
      assert.match(defaultManagedConfig, /consensus_type: etcdraft/);
      assert.match(defaultManagedConfig, /batch_timeout_seconds: 2/);

      const floatingVersionResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks',
        payload: {
          ...concurrentManagedPayload,
          id: 'managed-floating-version',
          displayName: 'Managed Floating Version',
          domain: 'managed-floating.test',
          fabricVersion: 'latest',
          fabricCaVersion: 'latest',
        },
      });
      assert.equal(floatingVersionResponse.statusCode, 400);
      assert.equal(floatingVersionResponse.json().error, 'invalid_managed_network');

      const invalidSoloResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks',
        payload: {
          ...concurrentManagedPayload,
          id: 'invalid-solo-network',
          displayName: 'Invalid Solo Network',
          domain: 'invalid-solo.test',
          ordererCount: 2,
          ordererConfiguration: { consensusType: 'solo' },
        },
      });
      assert.equal(invalidSoloResponse.statusCode, 400);
      assert.equal(invalidSoloResponse.json().error, 'invalid_managed_network');

      const fabricThreeSoloResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks',
        payload: {
          ...concurrentManagedPayload,
          id: 'fabric-three-solo',
          displayName: 'Fabric Three Solo',
          domain: 'fabric-three-solo.test',
          fabricVersion: '3.1.4',
          ordererConfiguration: { consensusType: 'solo' },
        },
      });
      assert.equal(fabricThreeSoloResponse.statusCode, 400);
      assert.equal(fabricThreeSoloResponse.json().error, 'invalid_managed_network');

      const invalidBatchSizeResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks',
        payload: {
          ...concurrentManagedPayload,
          id: 'invalid-batch-size',
          displayName: 'Invalid Batch Size',
          domain: 'invalid-batch.test',
          ordererConfiguration: {
            absoluteMaxBytesMiB: 1,
            preferredMaxBytesKiB: 2048,
          },
        },
      });
      assert.equal(invalidBatchSizeResponse.statusCode, 400);
      assert.equal(invalidBatchSizeResponse.json().error, 'invalid_managed_network');

      const managedResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks',
        payload: {
          id: 'managed-network',
          displayName: 'Managed Network',
          domain: 'managed.test',
          ordererCount: 2,
          peerOrganizations: [
            { name: 'alpha', mspId: 'AlphaMSP', peerCount: 2 },
            { name: 'beta', mspId: 'BetaMSP', peerCount: 1 },
          ],
          channels: [
            { name: 'shared-channel', memberOrganizations: ['alpha', 'beta'] },
            { name: 'alpha-private', memberOrganizations: ['alpha'] },
          ],
          preferredPortStart: 30_000,
          fabricVersion: '3.1.4',
          fabricCaVersion: '1.5.19',
          stateDatabase: 'couchdb',
          ordererConfiguration: {
            consensusType: 'etcdraft',
            batchTimeoutSeconds: 5,
            maxMessageCount: 25,
            absoluteMaxBytesMiB: 32,
            preferredMaxBytesKiB: 1024,
          },
        },
      });
      assert.equal(managedResponse.statusCode, 201);
      assert.deepEqual(managedResponse.json(), {
        id: 'managed-network',
        displayName: 'Managed Network',
        driver: 'fabric-compose',
        managementMode: 'managed',
        status: 'unknown',
        fabricVersion: '3.1.4',
        organizationCount: 2,
        channelCount: 2,
        nodeCount: 11,
        updatedAt: managedResponse.json().updatedAt,
      });
      const managedConfigPath = path.join(
        temporaryRoot,
        'managed-networks',
        'managed-network',
        'config',
        'orgs.yaml',
      );
      const managedConfig = readFileSync(managedConfigPath, 'utf8');
      assert.match(managedConfig, /namespace_containers: true/);
      assert.match(managedConfig, /display_name: Managed Network/);
      assert.match(managedConfig, /name: shared-channel/);
      assert.match(managedConfig, /name: alpha-private/);
      assert.match(managedConfig, /peer_count: 2/);
      assert.match(managedConfig, /fabric_version: 3\.1\.4/);
      assert.match(managedConfig, /fabric_ca_version: 1\.5\.19/);
      assert.match(managedConfig, /remove_docker_network_on_down: true/);
      assert.match(managedConfig, /state_database: couchdb/);
      assert.match(managedConfig, /couchdb_image: couchdb:3\.3\.3/);
      assert.match(managedConfig, /couchdb_port: 30012/);
      assert.match(managedConfig, /consensus_type: etcdraft/);
      assert.match(managedConfig, /batch_timeout_seconds: 5/);
      assert.match(managedConfig, /max_message_count: 25/);
      assert.match(managedConfig, /absolute_max_bytes_mib: 32/);
      assert.match(managedConfig, /preferred_max_bytes_kib: 1024/);
      assert.equal(
        readFileSync(
          path.join(temporaryRoot, 'managed-networks', 'managed-network', '.env'),
          'utf8',
        ),
        'COMPOSE_PROJECT_NAME=pf_managed_network\n',
      );
      assert.equal(
        readFileSync(
          path.join(temporaryRoot, 'managed-networks', 'managed-network', 'core-template.yaml'),
          'utf8',
        ).includes('{{DOCKER_NETWORK}}'),
        true,
      );
      assert.equal(
        statSync(
          path.join(temporaryRoot, 'managed-networks', 'managed-network', 'upgrade_chaincode.sh'),
        ).isFile(),
        true,
      );
      assert.equal(
        existsSync(
          path.join(
            temporaryRoot,
            'managed-networks',
            'managed-network',
            'script',
            'write-discovery-manifest.sh',
          ),
        ),
        true,
      );
      assert.equal(
        existsSync(
          path.join(
            temporaryRoot,
            'managed-networks',
            'managed-network',
            'script',
            'generate-docker-compose-peers.bk',
          ),
        ),
        false,
      );

      const managedTopologyResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/networks/managed-network/topology',
      });
      assert.equal(managedTopologyResponse.statusCode, 200);
      const managedTopology = NetworkTopologyResponseSchema.parse(
        managedTopologyResponse.json(),
      );
      assert.equal(managedTopology.nodes.length, 11);
      assert.equal(
        managedTopology.nodes.filter((node) => node.type === 'couchdb').length,
        3,
      );
      assert(
        managedTopology.nodes
          .filter((node) => node.type === 'couchdb')
          .every((node) => node.endpoints[0]?.kind === 'couchdb'),
      );
      const managedConfigurationResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/networks/managed-network/config',
      });
      assert.equal(managedConfigurationResponse.statusCode, 200);
      assert.equal(managedConfigurationResponse.json().stateDatabase, 'couchdb');
      assert.deepEqual(managedConfigurationResponse.json().ordererConfiguration, {
        consensusType: 'etcdraft',
        batchTimeoutSeconds: 5,
        maxMessageCount: 25,
        absoluteMaxBytesMiB: 32,
        preferredMaxBytesKiB: 1024,
      });
      assert.equal(
        existsSync(
          path.join(
            temporaryRoot,
            'managed-networks',
            'managed-network',
            'script',
            'core.yaml',
          ),
        ),
        false,
      );

      const emptyJobsResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?networkId=network-a',
      });
      assert.equal(emptyJobsResponse.statusCode, 200);
      assert.equal(JobListResponseSchema.parse(emptyJobsResponse.json()).total, 0);

      const unsafeDownResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks/network-a/actions/down',
        payload: {},
      });
      assert.equal(unsafeDownResponse.statusCode, 400);
      assert.equal(unsafeDownResponse.json().error, 'network_confirmation_required');

      const actionResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks/network-a/actions/restart',
        payload: {},
      });
      assert.equal(actionResponse.statusCode, 202);
      const queuedJob = JobSchema.parse(actionResponse.json());
      assert.equal(queuedJob.action, 'restart');
      assert.equal(queuedJob.status, 'queued');

      const finishedJob = await waitForJob(app, queuedJob.id, 'succeeded');
      assert.equal(finishedJob.exitCode, 0);
      assert.equal(finishedJob.steps[0]?.status, 'succeeded');

      const jobEventsResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${queuedJob.id}/events`,
      });
      const jobEvents = JobEventListResponseSchema.parse(jobEventsResponse.json());
      assert(jobEvents.items.some((event) => event.message === 'network restart completed'));

      const inventoryResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/networks/network-a/chaincodes',
      });
      assert.equal(inventoryResponse.statusCode, 200);
      const inventory = ChaincodeInventoryResponseSchema.parse(inventoryResponse.json());
      assert.deepEqual(inventory.channels, ['channel-a']);
      assert.equal(inventory.installedPackages[0]?.label, 'assetcc_1.0');
      assert.equal(inventory.committedDefinitions[0]?.name, 'assetcc');

      const evaluateResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks/network-a/contracts/evaluate',
        payload: {
          channelName: 'channel-a',
          chaincodeName: 'assetcc',
          organization: 'org1',
          functionName: 'ReadAsset',
          arguments: ['asset-1'],
        },
      });
      assert.equal(evaluateResponse.statusCode, 200);
      const evaluation = ContractExecutionResultSchema.parse(evaluateResponse.json());
      assert.deepEqual(evaluation.output.json, { ok: true });
      assert.equal(evaluation.transactionId, null);

      const submitResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks/network-a/contracts/submit',
        payload: {
          channelName: 'channel-a',
          chaincodeName: 'assetcc',
          organization: 'org1',
          functionName: 'CreateAsset',
          arguments: ['asset-1'],
          targetOrganizations: ['org1'],
          transient: { secret: 'redacted-value' },
        },
      });
      const submission = ContractExecutionResultSchema.parse(submitResponse.json());
      assert.equal(submission.transactionId, 'a'.repeat(64));

      const deploymentResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/networks/network-a/chaincodes/deployments',
        payload: {
          channelName: 'channel-a',
          name: 'assetcc',
          version: '1.1',
          sequence: 2,
          language: 'node',
          sourcePath: 'chaincode/assetcc',
        },
      });
      assert.equal(deploymentResponse.statusCode, 202);
      const deploymentJob = JobSchema.parse(deploymentResponse.json());
      assert.equal(deploymentJob.kind, 'chaincode-deployment');
      assert.equal(deploymentJob.context.name, 'assetcc');
      await waitForJob(app, deploymentJob.id, 'succeeded');

      const jobsResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?networkId=network-a',
      });
      assert.equal(JobListResponseSchema.parse(jobsResponse.json()).total, 2);
    } finally {
      await app.close();
    }

    const degradedApp = await buildApp(config, {
      dockerRuntime: observableDockerRuntime,
      serviceProbe: unreachableServiceProbe,
    });
    try {
      const degradedResponse = await degradedApp.inject({
        method: 'GET',
        url: '/api/v1/networks/network-a/nodes/orderer1.network-a.test',
      });
      const degradedOrderer = NetworkNodeSchema.parse(degradedResponse.json());
      assert.equal(degradedOrderer.runtime.containerRunning, true);
      assert.equal(degradedOrderer.runtime.serviceReachable, false);
      assert.equal(degradedOrderer.runtime.state, 'degraded');
    } finally {
      await degradedApp.close();
    }

    const restartedApp = await buildApp(config, { dockerRuntime: unavailableDockerRuntime });
    try {
      const persistedResponse = await restartedApp.inject({
        method: 'GET',
        url: '/api/v1/networks',
      });
      assert.equal(persistedResponse.statusCode, 200);
      assert.equal(persistedResponse.json().total, 4);
      assert.deepEqual(
        persistedResponse.json().items.map((network: { id: string }) => network.id).sort(),
        ['managed-network', 'managed-race', 'network-a', 'network-b'],
      );

      const unavailableNodesResponse = await restartedApp.inject({
        method: 'GET',
        url: '/api/v1/networks/network-a/nodes',
      });
      const unavailableNodes = NetworkNodeListResponseSchema.parse(
        unavailableNodesResponse.json(),
      );
      assert.equal(unavailableNodes.dockerAvailable, false);
      assert.equal(unavailableNodes.items[0]?.runtime.state, 'docker-unavailable');
      assert.equal(unavailableNodes.missing, 0);
      assert.equal(unavailableNodes.reachable, 0);
      assert.equal(unavailableNodes.unreachable, 0);
    } finally {
      await restartedApp.close();
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

async function waitForJob(
  app: Awaited<ReturnType<typeof buildApp>>,
  jobId: string,
  status: 'succeeded' | 'failed' | 'cancelled',
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}` });
    const job = JobSchema.parse(response.json());
    if (job.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Job ${jobId} did not reach ${status}.`);
}
