import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NetworkSummarySchema, type NetworkSummary } from '@plus-fabric/shared';

import type { RegisteredNetwork } from './network-driver.js';

type NetworkRow = {
  id: string;
  display_name: string;
  driver: RegisteredNetwork['driver'];
  management_mode: RegisteredNetwork['managementMode'];
  workspace_root: string;
  config_path: string;
  docker_network: string;
  compose_project: string;
  fabric_version: string | null;
  fabric_ca_version: string | null;
  organization_count: number;
  channel_count: number;
  node_count: number;
  created_at: string;
  updated_at: string;
};

export interface NetworkRegistry {
  list(): Promise<NetworkSummary[]>;
  listRegistered(): Promise<RegisteredNetwork[]>;
  listReservedPorts(): Promise<number[]>;
  get(id: string): Promise<RegisteredNetwork | null>;
  create(network: RegisteredNetwork, reservedPorts?: number[]): Promise<NetworkSummary>;
  delete(id: string): Promise<boolean>;
  close(): Promise<void>;
}

export class NetworkPortConflictError extends Error {
  constructor(readonly port: number) {
    super(`Port ${port} is already reserved by another network.`);
    this.name = 'NetworkPortConflictError';
  }
}

export class NetworkRegistryConflictError extends Error {
  constructor(readonly networkId: string) {
    super(`A network with id "${networkId}" is already registered.`);
    this.name = 'NetworkRegistryConflictError';
  }
}

export class NetworkNamespaceConflictError extends Error {
  constructor(
    readonly namespace: 'docker_network' | 'compose_project',
    readonly value: string,
  ) {
    super(
      `${namespace === 'docker_network' ? 'Docker network' : 'Compose project'} "${value}" is already registered.`,
    );
    this.name = 'NetworkNamespaceConflictError';
  }
}

class SqliteNetworkRegistry implements NetworkRegistry {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }

    this.#database = new Database(databasePath);
    this.#database.pragma('journal_mode = WAL');
    this.#database.pragma('foreign_keys = ON');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS networks (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        driver TEXT NOT NULL,
        management_mode TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        config_path TEXT NOT NULL,
        docker_network TEXT NOT NULL,
        compose_project TEXT NOT NULL,
        fabric_version TEXT,
        fabric_ca_version TEXT,
        organization_count INTEGER NOT NULL,
        channel_count INTEGER NOT NULL,
        node_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS network_ports (
        network_id TEXT NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
        port INTEGER NOT NULL UNIQUE CHECK(port BETWEEN 1 AND 65535),
        PRIMARY KEY(network_id, port)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS networks_docker_network_unique
        ON networks(docker_network);
      CREATE UNIQUE INDEX IF NOT EXISTS networks_compose_project_unique
        ON networks(compose_project);
    `);
  }

  async list(): Promise<NetworkSummary[]> {
    return (await this.listRegistered()).map(toNetworkSummary);
  }

  async listRegistered(): Promise<RegisteredNetwork[]> {
    const rows = this.#database
      .prepare('SELECT * FROM networks ORDER BY display_name COLLATE NOCASE, id')
      .all() as NetworkRow[];
    return rows.map(toRegisteredNetwork);
  }

  async listReservedPorts(): Promise<number[]> {
    const rows = this.#database.prepare('SELECT port FROM network_ports ORDER BY port').all() as Array<{
      port: number;
    }>;
    return rows.map((row) => row.port);
  }

  async get(id: string): Promise<RegisteredNetwork | null> {
    const row = this.#database.prepare('SELECT * FROM networks WHERE id = ?').get(id) as
      | NetworkRow
      | undefined;
    return row ? toRegisteredNetwork(row) : null;
  }

  async create(network: RegisteredNetwork, reservedPorts: number[] = []): Promise<NetworkSummary> {
    const create = this.#database.transaction(() => {
      this.#database
        .prepare(`
          INSERT INTO networks (
            id, display_name, driver, management_mode, workspace_root, config_path,
            docker_network, compose_project, fabric_version, fabric_ca_version,
            organization_count, channel_count, node_count, created_at, updated_at
          ) VALUES (
            @id, @displayName, @driver, @managementMode, @workspaceRoot, @configPath,
            @dockerNetwork, @composeProject, @fabricVersion, @fabricCaVersion,
            @organizationCount, @channelCount, @nodeCount, @createdAt, @updatedAt
          )
        `)
        .run(network);
      const insertPort = this.#database.prepare(
        'INSERT INTO network_ports (network_id, port) VALUES (?, ?)',
      );
      for (const port of new Set(reservedPorts)) insertPort.run(network.id, port);
    });

    try {
      create();
    } catch (error) {
      if (isSqliteConstraint(error)) {
        const idConflict = this.#database.prepare('SELECT 1 FROM networks WHERE id = ?').get(network.id);
        if (idConflict) throw new NetworkRegistryConflictError(network.id);
        const dockerNetworkConflict = this.#database
          .prepare('SELECT 1 FROM networks WHERE docker_network = ?')
          .get(network.dockerNetwork);
        if (dockerNetworkConflict) {
          throw new NetworkNamespaceConflictError('docker_network', network.dockerNetwork);
        }
        const composeProjectConflict = this.#database
          .prepare('SELECT 1 FROM networks WHERE compose_project = ?')
          .get(network.composeProject);
        if (composeProjectConflict) {
          throw new NetworkNamespaceConflictError('compose_project', network.composeProject);
        }
        const conflictingPort = reservedPorts.find((port) =>
          this.#database.prepare('SELECT 1 FROM network_ports WHERE port = ?').get(port),
        );
        if (conflictingPort !== undefined) throw new NetworkPortConflictError(conflictingPort);
        throw error;
      }
      throw error;
    }

    return toNetworkSummary(network);
  }

  async delete(id: string): Promise<boolean> {
    return this.#database.transaction(() => {
      const result = this.#database.prepare('DELETE FROM networks WHERE id = ?').run(id);
      return result.changes === 1;
    })();
  }

  async close(): Promise<void> {
    this.#database.close();
  }
}

function isSqliteConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  );
}

function toRegisteredNetwork(row: NetworkRow): RegisteredNetwork {
  return {
    id: row.id,
    displayName: row.display_name,
    driver: row.driver,
    managementMode: row.management_mode,
    workspaceRoot: row.workspace_root,
    configPath: row.config_path,
    dockerNetwork: row.docker_network,
    composeProject: row.compose_project,
    fabricVersion: row.fabric_version,
    fabricCaVersion: row.fabric_ca_version,
    organizationCount: row.organization_count,
    channelCount: row.channel_count,
    nodeCount: row.node_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toNetworkSummary(network: RegisteredNetwork | NetworkRow): NetworkSummary {
  const registered = 'display_name' in network ? toRegisteredNetwork(network) : network;

  return NetworkSummarySchema.parse({
    id: registered.id,
    displayName: registered.displayName,
    driver: registered.driver,
    managementMode: registered.managementMode,
    status: 'unknown',
    fabricVersion: registered.fabricVersion,
    organizationCount: registered.organizationCount,
    channelCount: registered.channelCount,
    nodeCount: registered.nodeCount,
    updatedAt: registered.updatedAt,
  });
}

export function createNetworkRegistry(databasePath: string): NetworkRegistry {
  return new SqliteNetworkRegistry(databasePath);
}
