import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

import {
  LedgerBlockListResponseSchema,
  LedgerChannelListResponseSchema,
  type LedgerBlock,
  type LedgerBlockListResponse,
  type LedgerBlockSummary,
  type LedgerChannel,
  type LedgerChannelListResponse,
} from '@plus-fabric/shared';

import type { NetworkImportService } from '../networks/network-import-service.js';
import type { NetworkRegistry } from '../networks/network-registry.js';
import { decodeFabricBlock } from './block-decoder.js';
import type {
  FabricLedgerRuntime,
  LedgerPeerContext,
} from './fabric-ledger-runtime.js';

export class LedgerServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'LedgerServiceError';
  }
}

export class LedgerService {
  constructor(
    private readonly networkRegistry: NetworkRegistry,
    private readonly networkImportService: NetworkImportService,
    private readonly runtime: FabricLedgerRuntime,
  ) {}

  async listChannels(networkId: string): Promise<LedgerChannelListResponse> {
    const context = await this.getContext(networkId);
    const observed = await this.discoverChannels(context.peers);
    const observedAt = new Date().toISOString();
    const items: LedgerChannel[] = [];

    for (const [name, peer] of observed) {
      try {
        const info = await this.runtime.getChannelInfo(peer, name);
        const height = BigInt(info.height);
        items.push({
          networkId,
          name,
          height: info.height,
          currentBlockNumber: height > 0n ? String(height - 1n) : null,
          currentBlockHash: info.currentBlockHash,
          previousBlockHash: info.previousBlockHash,
          observedPeer: peer.host,
          observedAt,
        });
      } catch (error) {
        throw ledgerUnavailable(error);
      }
    }

    items.sort((left, right) => left.name.localeCompare(right.name));
    return LedgerChannelListResponseSchema.parse({ networkId, items, total: items.length });
  }

  async listBlocks(
    networkId: string,
    channelName: string,
    limit: number,
    before?: string,
  ): Promise<LedgerBlockListResponse> {
    const context = await this.getContext(networkId);
    const peer = await this.findChannelPeer(context.peers, channelName);
    let info;
    try {
      info = await this.runtime.getChannelInfo(peer, channelName);
    } catch (error) {
      throw ledgerUnavailable(error);
    }

    const height = BigInt(info.height);
    if (height === 0n || before === '0') {
      return LedgerBlockListResponseSchema.parse({
        networkId,
        channelName,
        height: info.height,
        items: [],
        total: 0,
      });
    }

    const latest = height - 1n;
    const requestedStart = before === undefined ? latest : BigInt(before) - 1n;
    const start = requestedStart < latest ? requestedStart : latest;
    const blockNumbers: string[] = [];
    for (let offset = 0n; offset < BigInt(limit); offset += 1n) {
      const number = start - offset;
      if (number < 0n) break;
      blockNumbers.push(String(number));
    }

    let blocks: LedgerBlock[];
    try {
      blocks = await Promise.all(
        blockNumbers.map(async (blockNumber) =>
          decodeFabricBlock(
            networkId,
            channelName,
            await this.runtime.fetchBlock(peer, channelName, blockNumber),
          ),
        ),
      );
    } catch (error) {
      throw ledgerUnavailable(error);
    }

    const items = blocks.map(toBlockSummary);
    return LedgerBlockListResponseSchema.parse({
      networkId,
      channelName,
      height: info.height,
      items,
      total: items.length,
    });
  }

  async getBlock(
    networkId: string,
    channelName: string,
    blockNumber: string,
  ): Promise<LedgerBlock> {
    const context = await this.getContext(networkId);
    const peer = await this.findChannelPeer(context.peers, channelName);
    try {
      const bytes = await this.runtime.fetchBlock(
        peer,
        channelName,
        blockNumber,
      );
      return decodeFabricBlock(networkId, channelName, bytes);
    } catch (error) {
      throw ledgerUnavailable(error);
    }
  }

  private async getContext(networkId: string): Promise<{
    peers: LedgerPeerContext[];
  }> {
    const network = await this.networkRegistry.get(networkId);
    if (!network) {
      throw new LedgerServiceError(
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
      throw new LedgerServiceError(
        'ledger_context_unavailable',
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
      throw new LedgerServiceError(
        'ledger_context_unavailable',
        'The Fabric CLI, admin MSP, TLS certificate, or peer core.yaml is unavailable.',
        409,
      );
    }

    return { peers };
  }

  private async discoverChannels(
    peers: LedgerPeerContext[],
  ): Promise<Map<string, LedgerPeerContext>> {
    const results = await Promise.allSettled(
      peers.map(async (peer) => ({ peer, channels: await this.runtime.listChannels(peer) })),
    );
    const observed = new Map<string, LedgerPeerContext>();
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        errors.push(result.reason);
        continue;
      }
      for (const channel of result.value.channels) {
        if (!observed.has(channel)) observed.set(channel, result.value.peer);
      }
    }
    if (observed.size === 0 && errors.length > 0) throw ledgerUnavailable(errors[0]);
    return observed;
  }

  private async findChannelPeer(
    peers: LedgerPeerContext[],
    channelName: string,
  ): Promise<LedgerPeerContext> {
    let lastError: unknown;
    for (const peer of peers) {
      try {
        if ((await this.runtime.listChannels(peer)).includes(channelName)) return peer;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw ledgerUnavailable(lastError);
    throw new LedgerServiceError(
      'channel_not_found',
      `Channel "${channelName}" was not found on any configured peer.`,
      404,
    );
  }
}

function toBlockSummary(block: LedgerBlock): LedgerBlockSummary {
  return {
    number: block.number,
    previousHash: block.previousHash,
    dataHash: block.dataHash,
    transactionCount: block.transactionCount,
    validTransactionCount: block.validTransactionCount,
    invalidTransactionCount: block.invalidTransactionCount,
    timestamp: block.timestamp,
    chaincodes: block.chaincodes,
  };
}

function ledgerUnavailable(error: unknown): LedgerServiceError {
  if (error instanceof LedgerServiceError) return error;
  return new LedgerServiceError(
    'ledger_unavailable',
    error instanceof Error ? error.message : 'The Fabric ledger is unavailable.',
    503,
  );
}
