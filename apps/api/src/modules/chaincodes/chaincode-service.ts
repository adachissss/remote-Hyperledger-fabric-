import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

import {
  ChaincodeInventoryResponseSchema,
  ContractExecutionResultSchema,
  type ChaincodeInventoryResponse,
  type ContractExecutionMode,
  type ContractExecutionRequest,
  type ContractExecutionResult,
} from '@plus-fabric/shared';

import type { JobService } from '../jobs/job-service.js';
import type {
  FabricLedgerRuntime,
  LedgerPeerContext,
} from '../ledger/fabric-ledger-runtime.js';
import { decodeLedgerValue } from '../ledger/block-decoder.js';
import type { NetworkImportService } from '../networks/network-import-service.js';
import type { NetworkRegistry } from '../networks/network-registry.js';
import type { RegisteredNetwork } from '../networks/network-driver.js';
import type { FabricComposeConfigSnapshot } from '../networks/fabric-compose-config.js';
import type {
  ChaincodeOrdererContext,
  FabricChaincodeRuntime,
} from './fabric-chaincode-runtime.js';

export class ChaincodeServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ChaincodeServiceError';
  }
}

export class ChaincodeService {
  constructor(
    private readonly networkRegistry: NetworkRegistry,
    private readonly networkImportService: NetworkImportService,
    private readonly ledgerRuntime: FabricLedgerRuntime,
    private readonly chaincodeRuntime: FabricChaincodeRuntime,
    private readonly jobService: JobService,
  ) {}

  async getInventory(networkId: string): Promise<ChaincodeInventoryResponse> {
    const context = await this.getContext(networkId);
    const channelPeers = await this.discoverChannels(context.peers);
    const installedResults = await Promise.allSettled(
      context.peers.map(async (peer) => ({
        peer,
        packages: await this.chaincodeRuntime.queryInstalled(peer),
      })),
    );
    const installedPackages = installedResults.flatMap((result) =>
      result.status === 'fulfilled'
        ? result.value.packages.map((entry) => ({
            ...entry,
            organization: result.value.peer.organizationName,
            mspId: result.value.peer.mspId,
            observedPeer: result.value.peer.host,
          }))
        : [],
    );
    if (
      installedResults.length > 0 &&
      installedResults.every((result) => result.status === 'rejected')
    ) {
      throw chaincodeUnavailable(installedResults[0]?.reason);
    }

    const committedResults = await Promise.allSettled(
      [...channelPeers].map(async ([channelName, peer]) => ({
        channelName,
        peer,
        definitions: await this.chaincodeRuntime.queryCommitted(peer, channelName),
      })),
    );
    const committedDefinitions = committedResults.flatMap((result) =>
      result.status === 'fulfilled'
        ? result.value.definitions.map((definition) => ({
            ...definition,
            channelName: result.value.channelName,
            observedPeer: result.value.peer.host,
          }))
        : [],
    );
    if (
      committedResults.length > 0 &&
      committedResults.every((result) => result.status === 'rejected')
    ) {
      throw chaincodeUnavailable(committedResults[0]?.reason);
    }

    return ChaincodeInventoryResponseSchema.parse({
      networkId,
      channels: [...channelPeers.keys()].sort(),
      organizations: context.peers.map((peer) => ({
        name: peer.organizationName,
        mspId: peer.mspId,
        observedPeer: peer.host,
      })),
      installedPackages,
      committedDefinitions: committedDefinitions.sort((left, right) =>
        left.channelName.localeCompare(right.channelName) || left.name.localeCompare(right.name),
      ),
      observedAt: new Date().toISOString(),
    });
  }

  async createDeployment(networkId: string, request: Parameters<JobService['createChaincodeDeployment']>[1]) {
    return this.jobService.createChaincodeDeployment(networkId, request);
  }

  async execute(
    networkId: string,
    mode: ContractExecutionMode,
    request: ContractExecutionRequest,
  ): Promise<ContractExecutionResult> {
    const startedAt = Date.now();
    const context = await this.getContext(networkId);
    const invokingPeer = findOrganizationPeer(context.peers, request.organization);
    if (!invokingPeer) {
      throw new ChaincodeServiceError(
        'chaincode_organization_not_found',
        `Organization "${request.organization}" is not configured in this network.`,
        404,
      );
    }

    let joinedChannels: string[];
    try {
      joinedChannels = await this.ledgerRuntime.listChannels(invokingPeer);
    } catch (error) {
      throw chaincodeUnavailable(error);
    }
    if (!joinedChannels.includes(request.channelName)) {
      throw new ChaincodeServiceError(
        'channel_not_found',
        `The selected organization is not joined to channel "${request.channelName}".`,
        404,
      );
    }

    let targetPeers: LedgerPeerContext[] = [];
    if (mode === 'submit') {
      const membership = new Map<string, boolean>();
      const membershipResults = await Promise.allSettled(
        context.peers.map(async (peer) => ({
          peer,
          joined: peer === invokingPeer
            ? joinedChannels.includes(request.channelName)
            : (await this.ledgerRuntime.listChannels(peer)).includes(request.channelName),
        })),
      );
      for (const result of membershipResults) {
        if (result.status === 'fulfilled') membership.set(result.value.peer.mspId, result.value.joined);
      }

      const requestedTargets =
        request.targetOrganizations.length === 0
          ? context.peers.filter((peer) => membership.get(peer.mspId) === true)
          : request.targetOrganizations.map((organization) => {
              const peer = findOrganizationPeer(context.peers, organization);
              if (!peer) {
                throw new ChaincodeServiceError(
                  'chaincode_target_organization_not_found',
                  `Target organization "${organization}" is not configured in this network.`,
                  404,
                );
              }
              if (membership.get(peer.mspId) !== true) {
                throw new ChaincodeServiceError(
                  'chaincode_target_not_joined',
                  `Target organization "${organization}" is not joined to channel "${request.channelName}".`,
                  409,
                );
              }
              return peer;
            });
      targetPeers = requestedTargets;
      if (targetPeers.length === 0) {
        throw new ChaincodeServiceError(
          'chaincode_targets_unavailable',
          `No configured peer is available on channel "${request.channelName}".`,
          409,
        );
      }
    }

    const orderer = await buildOrdererContext(
      context.network,
      context.snapshot,
    );
    try {
      const result = await this.chaincodeRuntime.executeContract({
        mode,
        request,
        invokingPeer,
        targetPeers: deduplicatePeers(targetPeers),
        orderer,
      });
      return ContractExecutionResultSchema.parse({
        networkId,
        mode,
        channelName: request.channelName,
        chaincodeName: request.chaincodeName,
        organization: invokingPeer.organizationName,
        functionName: request.functionName,
        transactionId: result.transactionId,
        responseStatus: result.responseStatus,
        output: decodeLedgerValue(result.output),
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof ChaincodeServiceError) throw error;
      throw chaincodeUnavailable(error);
    }
  }

  private async getContext(networkId: string): Promise<{
    network: RegisteredNetwork;
    snapshot: FabricComposeConfigSnapshot;
    peers: LedgerPeerContext[];
  }> {
    const network = await this.networkRegistry.get(networkId);
    if (!network) {
      throw new ChaincodeServiceError(
        'network_not_found',
        `Network "${networkId}" is not registered.`,
        404,
      );
    }
    const snapshot = await this.networkImportService.getSnapshot(networkId);
    const executable = path.join(network.workspaceRoot, 'bin', 'peer');
    const peers = snapshot.redacted.peerOrganizations.flatMap((organization) => {
      const peer = snapshot.topology.nodes.find(
        (node) => node.type === 'peer' && node.mspId === organization.mspId,
      );
      const endpoint = peer?.endpoints.find((candidate) => candidate.kind === 'grpc');
      if (!peer || !endpoint) return [];
      const identityDomain = `${snapshot.envPrefix}-${organization.domain}`;
      const peerRoot = path.join(
        network.workspaceRoot,
        'organizations',
        'peerOrganizations',
        identityDomain,
      );
      return [
        {
          executable,
          workspaceRoot: network.workspaceRoot,
          configPath: network.configPath,
          composeProject: network.composeProject,
          organizationName: organization.name,
          mspId: organization.mspId,
          host: peer.host,
          address: `${peer.host}:${endpoint.internalPort}`,
          adminMspPath: path.join(peerRoot, 'users', `Admin@${identityDomain}`, 'msp'),
          tlsRootCertPath: path.join(peerRoot, 'peers', peer.host, 'tls', 'ca.crt'),
          fabricConfigPath: path.join(peerRoot, 'peers', peer.host),
        } satisfies LedgerPeerContext,
      ];
    });
    if (peers.length === 0) {
      throw new ChaincodeServiceError(
        'chaincode_context_unavailable',
        'The network does not define a usable peer organization.',
        409,
      );
    }
    try {
      await Promise.all([
        access(executable, constants.X_OK),
        ...peers.flatMap((peer) => [
          access(peer.adminMspPath, constants.R_OK),
          access(peer.tlsRootCertPath, constants.R_OK),
          access(path.join(peer.fabricConfigPath, 'core.yaml'), constants.R_OK),
        ]),
      ]);
    } catch {
      throw new ChaincodeServiceError(
        'chaincode_context_unavailable',
        'The Fabric CLI, admin MSP, TLS certificate, or peer core.yaml is unavailable.',
        409,
      );
    }
    return { network, snapshot, peers };
  }

  private async discoverChannels(
    peers: LedgerPeerContext[],
  ): Promise<Map<string, LedgerPeerContext>> {
    const results = await Promise.allSettled(
      peers.map(async (peer) => ({ peer, channels: await this.ledgerRuntime.listChannels(peer) })),
    );
    const channels = new Map<string, LedgerPeerContext>();
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        errors.push(result.reason);
        continue;
      }
      for (const channel of result.value.channels) {
        if (!channels.has(channel)) channels.set(channel, result.value.peer);
      }
    }
    if (channels.size === 0 && errors.length > 0) throw chaincodeUnavailable(errors[0]);
    return channels;
  }
}

function findOrganizationPeer(
  peers: LedgerPeerContext[],
  organization: string,
): LedgerPeerContext | undefined {
  const normalized = organization.toLowerCase();
  return peers.find(
    (peer) =>
      peer.organizationName.toLowerCase() === normalized || peer.mspId.toLowerCase() === normalized,
  );
}

function deduplicatePeers(peers: LedgerPeerContext[]): LedgerPeerContext[] {
  return [...new Map(peers.map((peer) => [peer.mspId, peer])).values()];
}

async function buildOrdererContext(
  network: RegisteredNetwork,
  snapshot: FabricComposeConfigSnapshot,
): Promise<ChaincodeOrdererContext> {
  const orderer = snapshot.redacted.orderers[0];
  if (!orderer) {
    throw new ChaincodeServiceError(
      'chaincode_context_unavailable',
      'The network does not define an orderer.',
      409,
    );
  }
  const tlsRootCertPath = path.join(
    network.workspaceRoot,
    'organizations',
    'ordererOrganizations',
    snapshot.ordererDomain,
    'orderers',
    orderer.host,
    'tls',
    'ca.crt',
  );
  try {
    await access(tlsRootCertPath, constants.R_OK);
  } catch {
    throw new ChaincodeServiceError(
      'chaincode_context_unavailable',
      'The orderer TLS certificate is unavailable.',
      409,
    );
  }
  return {
    address: `${orderer.host}:${orderer.port}`,
    host: orderer.host,
    tlsRootCertPath,
  };
}

function chaincodeUnavailable(error: unknown): ChaincodeServiceError {
  if (error instanceof ChaincodeServiceError) return error;
  return new ChaincodeServiceError(
    'chaincode_unavailable',
    error instanceof Error ? error.message : 'The Fabric chaincode service is unavailable.',
    503,
  );
}
