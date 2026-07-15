import type {
  NetworkDriver as NetworkDriverKind,
  NetworkManagementMode,
  NetworkSummary,
} from '@plus-fabric/shared';

export type RegisteredNetwork = {
  id: string;
  displayName: string;
  driver: NetworkDriverKind;
  managementMode: NetworkManagementMode;
  workspaceRoot: string;
  configPath: string;
  dockerNetwork: string;
  composeProject: string;
  fabricVersion: string | null;
  fabricCaVersion: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface NetworkDriverAdapter {
  readonly kind: NetworkDriverKind;
  getSummary(network: RegisteredNetwork): Promise<NetworkSummary>;
}

export interface NetworkDriverRegistry {
  get(kind: NetworkDriverKind): NetworkDriverAdapter;
  has(kind: NetworkDriverKind): boolean;
}
