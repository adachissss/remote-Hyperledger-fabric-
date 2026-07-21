import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  NetworkDiscoveryListResponseSchema,
  NetworkDiscoveryManifestSchema,
  type NetworkDiscoveryCandidate,
  type NetworkDiscoveryListResponse,
  type NetworkDiscoveryManifest,
} from '@plus-fabric/shared';

import type { RegisteredNetwork } from './network-driver.js';
import type { NetworkRegistry } from './network-registry.js';

export class NetworkDiscoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'NetworkDiscoveryError';
  }
}

export class NetworkDiscoveryService {
  constructor(
    private readonly registry: NetworkRegistry,
    private readonly discoveryRoot: string,
  ) {}

  async list(): Promise<NetworkDiscoveryListResponse> {
    const registered = await this.registry.listRegistered();
    const manifests = await this.readManifests();
    const items = await Promise.all(
      manifests.valid.map((manifest) => this.toCandidate(manifest, registered)),
    );
    items.sort((left, right) =>
      right.manifest.updatedAt.localeCompare(left.manifest.updatedAt) ||
      left.manifest.networkId.localeCompare(right.manifest.networkId),
    );
    return NetworkDiscoveryListResponseSchema.parse({
      items,
      total: items.length,
      invalidManifestCount: manifests.invalidCount,
    });
  }

  async getImportableManifest(networkId: string): Promise<NetworkDiscoveryManifest> {
    const discoveries = await this.list();
    const matches = discoveries.items.filter(
      (candidate) => candidate.manifest.networkId === networkId,
    );
    if (matches.length === 0) {
      throw new NetworkDiscoveryError(
        'network_discovery_not_found',
        `No discovery manifest exists for network "${networkId}".`,
        404,
      );
    }
    if (matches.length > 1) {
      throw new NetworkDiscoveryError(
        'network_discovery_ambiguous',
        `Multiple discovery manifests exist for network "${networkId}".`,
        409,
      );
    }
    const candidate = matches[0]!;
    if (candidate.registrationStatus !== 'unregistered') {
      throw new NetworkDiscoveryError(
        'network_discovery_not_importable',
        `The discovered network is ${candidate.registrationStatus} and cannot be imported.`,
        409,
      );
    }
    await this.assertWorkspaceManifest(candidate.manifest);
    return candidate.manifest;
  }

  private async readManifests() {
    let entries;
    try {
      entries = await readdir(this.discoveryRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissingPath(error)) return { valid: [], invalidCount: 0 };
      throw error;
    }

    const valid = [];
    let invalidCount = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const content = await readFile(path.join(this.discoveryRoot, entry.name), 'utf8');
        valid.push(NetworkDiscoveryManifestSchema.parse(JSON.parse(content)));
      } catch {
        invalidCount += 1;
      }
    }
    return { valid, invalidCount };
  }

  private async toCandidate(
    manifest: (typeof NetworkDiscoveryManifestSchema)['_output'],
    registered: RegisteredNetwork[],
  ): Promise<NetworkDiscoveryCandidate> {
    const workspaceRoot = await resolveDirectory(manifest.workspaceRoot);
    const configPath = await resolveFile(manifest.configPath);
    const workspaceAvailable = workspaceRoot !== null;
    const configAvailable =
      workspaceRoot !== null && configPath !== null && isWithin(workspaceRoot, configPath);

    const exactRegistration = registered.find(
      (network) =>
        network.workspaceRoot === workspaceRoot &&
        network.composeProject === manifest.composeProject &&
        network.dockerNetwork === manifest.dockerNetwork,
    );
    if (exactRegistration) {
      return {
        manifest,
        registrationStatus: 'registered',
        registeredNetworkId: exactRegistration.id,
        workspaceAvailable,
        configAvailable,
      };
    }

    const conflict = registered.find(
      (network) =>
        network.id === manifest.networkId ||
        network.workspaceRoot === workspaceRoot ||
        network.composeProject === manifest.composeProject ||
        network.dockerNetwork === manifest.dockerNetwork,
    );
    if (conflict) {
      return {
        manifest,
        registrationStatus: 'conflict',
        registeredNetworkId: conflict.id,
        workspaceAvailable,
        configAvailable,
      };
    }

    return {
      manifest,
      registrationStatus:
        workspaceAvailable && configAvailable ? 'unregistered' : 'stale',
      registeredNetworkId: null,
      workspaceAvailable,
      configAvailable,
    };
  }

  private async assertWorkspaceManifest(indexManifest: NetworkDiscoveryManifest): Promise<void> {
    try {
      const workspaceManifest = NetworkDiscoveryManifestSchema.parse(
        JSON.parse(
          await readFile(
            path.join(indexManifest.workspaceRoot, '.plus-fabric', 'network.json'),
            'utf8',
          ),
        ),
      );
      const fields: Array<keyof NetworkDiscoveryManifest> = [
        'schemaVersion',
        'networkId',
        'workspaceRoot',
        'configPath',
        'composeProject',
        'dockerNetwork',
      ];
      if (fields.some((field) => workspaceManifest[field] !== indexManifest[field])) {
        throw new Error('manifest mismatch');
      }
    } catch {
      throw new NetworkDiscoveryError(
        'network_discovery_manifest_mismatch',
        'The workspace discovery manifest is missing or does not match the discovery index.',
        409,
      );
    }
  }
}

async function resolveDirectory(value: string): Promise<string | null> {
  try {
    const resolved = await realpath(value);
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function resolveFile(value: string): Promise<string | null> {
  try {
    const resolved = await realpath(value);
    return (await stat(resolved)).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
