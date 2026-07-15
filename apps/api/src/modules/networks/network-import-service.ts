import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type {
  ImportNetworkRequest,
  NetworkSummary,
  RedactedNetworkConfiguration,
} from '@plus-fabric/shared';

import { readFabricComposeConfig } from './fabric-compose-config.js';
import type { RegisteredNetwork } from './network-driver.js';
import {
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
  ) {}

  async import(request: ImportNetworkRequest): Promise<NetworkSummary> {
    const workspaceRoot = this.resolveWorkspaceRoot(request.workspaceRoot);
    const configPath = this.resolveConfigPath(workspaceRoot, request.configPath);

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
      return await this.registry.create(network);
    } catch (error) {
      if (error instanceof NetworkRegistryConflictError) {
        throw new NetworkImportError('network_exists', error.message, 409);
      }
      throw error;
    }
  }

  async getConfig(networkId: string): Promise<RedactedNetworkConfiguration> {
    const network = await this.registry.get(networkId);
    if (!network) {
      throw new NetworkImportError(
        'network_not_found',
        `Network "${networkId}" is not registered.`,
        404,
      );
    }

    try {
      const workspaceRoot = this.resolveWorkspaceRoot(network.workspaceRoot);
      const relativeConfigPath = path.relative(workspaceRoot, network.configPath);
      const configPath = this.resolveConfigPath(workspaceRoot, relativeConfigPath);
      return readFabricComposeConfig(network.id, configPath).redacted;
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
