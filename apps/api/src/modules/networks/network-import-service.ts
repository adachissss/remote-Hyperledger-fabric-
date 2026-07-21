import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  ImportNetworkRequestSchema,
  NetworkIdSchema,
  type ImportNetworkRequest,
  type ImportNetworkDiscoveryRequest,
  type NetworkDiscoveryManifest,
  type NetworkSummary,
  type RedactedNetworkConfiguration,
} from '@plus-fabric/shared';

import {
  collectPublishedHostPorts,
  readFabricComposeConfig,
  type FabricComposeConfigSnapshot,
} from './fabric-compose-config.js';
import type { RegisteredNetwork } from './network-driver.js';
import {
  NetworkNamespaceConflictError,
  NetworkPortConflictError,
  NetworkRegistryConflictError,
  type NetworkRegistry,
} from './network-registry.js';

export class NetworkImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'NetworkImportError';
  }
}

export class NetworkImportService {
  constructor(
    private readonly registry: NetworkRegistry,
    private readonly allowedRoots: string[],
    private readonly managedNetworkRoot: string | null = null,
  ) {}

  async import(request: ImportNetworkRequest): Promise<NetworkSummary> {
    const workspaceRoot = this.resolveWorkspaceRoot(request.workspaceRoot);
    const configPath = this.resolveConfigPath(workspaceRoot, request.configPath);

    return this.importResolved(request, workspaceRoot, configPath);
  }

  async importDiscovered(
    manifest: NetworkDiscoveryManifest,
    overrides: ImportNetworkDiscoveryRequest,
  ): Promise<NetworkSummary> {
    const id = overrides.id ?? manifest.networkId;
    if (!NetworkIdSchema.safeParse(id).success) {
      throw new NetworkImportError(
        'discovery_network_id_requires_override',
        'The discovered network id is not valid for registration; provide a lowercase id override.',
        400,
      );
    }

    const workspaceRoot = this.resolveDiscoveredWorkspaceRoot(manifest.workspaceRoot);
    const configPath = this.resolveDiscoveredConfigPath(workspaceRoot, manifest.configPath);
    const request = ImportNetworkRequestSchema.safeParse({
      id,
      displayName: overrides.displayName ?? manifest.displayName,
      driver: 'fabric-compose',
      workspaceRoot,
      configPath: path.relative(workspaceRoot, configPath),
      composeProject: manifest.composeProject,
      fabricVersion: manifest.fabricVersion,
      fabricCaVersion: manifest.fabricCaVersion,
    });
    if (!request.success) {
      throw new NetworkImportError(
        'invalid_network_discovery_import',
        'The discovery manifest contains values that cannot be registered.',
        400,
      );
    }
    return this.importResolved(request.data, workspaceRoot, configPath);
  }

  private async importResolved(
    request: ImportNetworkRequest,
    workspaceRoot: string,
    configPath: string,
  ): Promise<NetworkSummary> {
    if (await this.registry.get(request.id)) {
      throw new NetworkImportError(
        'network_exists',
        `A network with id "${request.id}" is already registered.`,
        409,
      );
    }

    let snapshot;
    try {
      snapshot = readFabricComposeConfig(request.id, configPath);
    } catch (error) {
      throw new NetworkImportError(
        'invalid_network_config',
        error instanceof Error ? error.message : 'The Fabric network config could not be parsed.',
        400,
      );
    }

    const timestamp = new Date().toISOString();
    const network: RegisteredNetwork = {
      id: request.id,
      displayName: request.displayName,
      driver: request.driver,
      managementMode: 'imported',
      workspaceRoot,
      configPath,
      dockerNetwork: snapshot.dockerNetwork,
      composeProject: request.composeProject,
      fabricVersion: request.fabricVersion,
      fabricCaVersion: request.fabricCaVersion,
      organizationCount: snapshot.organizationCount,
      channelCount: snapshot.channelCount,
      nodeCount: snapshot.nodeCount,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      return await this.registry.create(network, collectPublishedHostPorts(snapshot));
    } catch (error) {
      if (error instanceof NetworkRegistryConflictError) {
        throw new NetworkImportError('network_exists', error.message, 409);
      }
      if (error instanceof NetworkNamespaceConflictError) {
        throw new NetworkImportError('network_namespace_conflict', error.message, 409);
      }
      if (error instanceof NetworkPortConflictError) {
        throw new NetworkImportError('network_port_conflict', error.message, 409);
      }
      throw error;
    }
  }

  async getConfig(networkId: string): Promise<RedactedNetworkConfiguration> {
    return (await this.getSnapshot(networkId)).redacted;
  }

  async getSnapshot(networkId: string): Promise<FabricComposeConfigSnapshot> {
    const network = await this.registry.get(networkId);
    if (!network) {
      throw new NetworkImportError(
        'network_not_found',
        `Network "${networkId}" is not registered.`,
        404,
      );
    }

    try {
      const workspaceRoot =
        network.managementMode === 'managed'
          ? this.resolveManagedWorkspaceRoot(network.workspaceRoot)
          : this.resolveWorkspaceRoot(network.workspaceRoot);
      const relativeConfigPath = path.relative(workspaceRoot, network.configPath);
      const configPath = this.resolveConfigPath(workspaceRoot, relativeConfigPath);
      return readFabricComposeConfig(network.id, configPath);
    } catch (error) {
      throw new NetworkImportError(
        'network_config_unavailable',
        error instanceof Error ? error.message : 'The network config is unavailable.',
        503,
      );
    }
  }

  private resolveWorkspaceRoot(requestedRoot: string): string {
    if (this.allowedRoots.length === 0) {
      throw new NetworkImportError(
        'network_import_disabled',
        'No network workspace roots have been allowed by the control-plane administrator.',
        403,
      );
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = realpathSync(path.resolve(requestedRoot));
      if (!statSync(workspaceRoot).isDirectory()) {
        throw new Error('not a directory');
      }
    } catch {
      throw new NetworkImportError(
        'workspace_not_found',
        'The requested network workspace does not exist or is not a directory.',
        400,
      );
    }

    const allowed = this.allowedRoots.some((root) => {
      try {
        return isWithin(realpathSync(root), workspaceRoot);
      } catch {
        return false;
      }
    });

    if (!allowed) {
      throw new NetworkImportError(
        'workspace_not_allowed',
        'The requested network workspace is outside the configured allowed roots.',
        403,
      );
    }

    return workspaceRoot;
  }

  private resolveManagedWorkspaceRoot(requestedRoot: string): string {
    if (!this.managedNetworkRoot) {
      throw new NetworkImportError(
        'network_config_unavailable',
        'The managed network root is not configured.',
        503,
      );
    }
    try {
      const managedRoot = realpathSync(this.managedNetworkRoot);
      const workspaceRoot = realpathSync(path.resolve(requestedRoot));
      if (!statSync(workspaceRoot).isDirectory() || !isWithin(managedRoot, workspaceRoot)) {
        throw new Error('outside managed root');
      }
      return workspaceRoot;
    } catch {
      throw new NetworkImportError(
        'network_config_unavailable',
        'The managed network workspace is unavailable.',
        503,
      );
    }
  }

  private resolveDiscoveredWorkspaceRoot(requestedRoot: string): string {
    try {
      const workspaceRoot = realpathSync(path.resolve(requestedRoot));
      if (!statSync(workspaceRoot).isDirectory()) throw new Error('not a directory');
      return workspaceRoot;
    } catch {
      throw new NetworkImportError(
        'discovery_workspace_unavailable',
        'The discovered network workspace is unavailable.',
        409,
      );
    }
  }

  private resolveDiscoveredConfigPath(workspaceRoot: string, requestedPath: string): string {
    try {
      const configPath = realpathSync(path.resolve(requestedPath));
      if (!isWithin(workspaceRoot, configPath) || !statSync(configPath).isFile()) {
        throw new Error('invalid discovered config path');
      }
      return configPath;
    } catch {
      throw new NetworkImportError(
        'discovery_config_unavailable',
        'The discovered network config is unavailable inside its workspace.',
        409,
      );
    }
  }

  private resolveConfigPath(workspaceRoot: string, requestedPath: string): string {
    if (path.isAbsolute(requestedPath)) {
      throw new NetworkImportError(
        'invalid_config_path',
        'The network config path must be relative to the workspace.',
        400,
      );
    }

    try {
      const configPath = realpathSync(path.resolve(workspaceRoot, requestedPath));
      if (!isWithin(workspaceRoot, configPath) || !statSync(configPath).isFile()) {
        throw new Error('invalid config path');
      }
      return configPath;
    } catch {
      throw new NetworkImportError(
        'config_not_found',
        'The network config does not exist inside the requested workspace.',
        400,
      );
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
