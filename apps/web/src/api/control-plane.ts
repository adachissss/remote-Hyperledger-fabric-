import {
  HealthResponseSchema,
  ImportNetworkRequestSchema,
  NetworkListResponseSchema,
  NetworkNodeListResponseSchema,
  NetworkNodeSchema,
  NetworkSummarySchema,
  NetworkTopologyResponseSchema,
  type HealthResponse,
  type ImportNetworkRequest,
  type NetworkListResponse,
  type NetworkNode,
  type NetworkNodeListResponse,
  type NetworkSummary,
  type NetworkTopologyResponse,
} from '@plus-fabric/shared';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '';

export class ControlPlaneApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'ControlPlaneApiError';
  }
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as
      | { error?: unknown; message?: unknown }
      | null;
    throw new ControlPlaneApiError(
      typeof errorPayload?.message === 'string'
        ? errorPayload.message
        : `Control plane request failed with status ${response.status}.`,
      response.status,
      typeof errorPayload?.error === 'string' ? errorPayload.error : null,
    );
  }

  return response.json();
}

export async function getSystemHealth(): Promise<HealthResponse> {
  return HealthResponseSchema.parse(await requestJson('/api/v1/system/health'));
}

export async function getNetworks(): Promise<NetworkListResponse> {
  return NetworkListResponseSchema.parse(await requestJson('/api/v1/networks'));
}

export async function importNetwork(request: ImportNetworkRequest): Promise<NetworkSummary> {
  const payload = ImportNetworkRequestSchema.parse(request);
  return NetworkSummarySchema.parse(
    await requestJson('/api/v1/networks/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  );
}

export async function getNetworkTopology(networkId: string): Promise<NetworkTopologyResponse> {
  const topology = NetworkTopologyResponseSchema.parse(
    await requestJson(`/api/v1/networks/${encodeURIComponent(networkId)}/topology`),
  );
  assertNetworkScope(networkId, topology.networkId);
  return topology;
}

export async function getNetworkNodes(networkId: string): Promise<NetworkNodeListResponse> {
  const nodes = NetworkNodeListResponseSchema.parse(
    await requestJson(`/api/v1/networks/${encodeURIComponent(networkId)}/nodes`),
  );
  assertNetworkScope(networkId, nodes.networkId);
  return nodes;
}

export async function getNetworkNode(networkId: string, nodeId: string): Promise<NetworkNode> {
  return NetworkNodeSchema.parse(
    await requestJson(
      `/api/v1/networks/${encodeURIComponent(networkId)}/nodes/${encodeURIComponent(nodeId)}`,
    ),
  );
}

function assertNetworkScope(requestedNetworkId: string, responseNetworkId: string): void {
  if (requestedNetworkId !== responseNetworkId) {
    throw new ControlPlaneApiError(
      'The control plane returned data for a different network.',
      502,
      'network_scope_mismatch',
    );
  }
}
