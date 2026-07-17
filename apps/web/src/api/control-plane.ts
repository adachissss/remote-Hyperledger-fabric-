import {
  HealthResponseSchema,
  ImportNetworkRequestSchema,
  JobEventListResponseSchema,
  JobEventSchema,
  JobListResponseSchema,
  JobSchema,
  LedgerBlockListResponseSchema,
  LedgerBlockSchema,
  LedgerChannelListResponseSchema,
  NetworkListResponseSchema,
  NetworkNodeListResponseSchema,
  NetworkNodeSchema,
  RedactedNetworkConfigurationSchema,
  NetworkSummarySchema,
  NetworkTopologyResponseSchema,
  type HealthResponse,
  type ImportNetworkRequest,
  type Job,
  type JobEvent,
  type JobEventListResponse,
  type JobListResponse,
  type LedgerBlock,
  type LedgerBlockListResponse,
  type LedgerChannelListResponse,
  type NetworkListResponse,
  type NetworkNode,
  type NetworkNodeListResponse,
  type RedactedNetworkConfiguration,
  type NetworkSummary,
  type NetworkTopologyResponse,
  type NetworkLifecycleAction,
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
        : `控制平面请求失败，状态码 ${response.status}。`,
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

export async function getNetworkConfiguration(
  networkId: string,
): Promise<RedactedNetworkConfiguration> {
  const configuration = RedactedNetworkConfigurationSchema.parse(
    await requestJson(`/api/v1/networks/${encodeURIComponent(networkId)}/config`),
  );
  assertNetworkScope(networkId, configuration.networkId);
  return configuration;
}

export async function getLedgerChannels(networkId: string): Promise<LedgerChannelListResponse> {
  const channels = LedgerChannelListResponseSchema.parse(
    await requestJson(`/api/v1/networks/${encodeURIComponent(networkId)}/channels`),
  );
  assertNetworkScope(networkId, channels.networkId);
  return channels;
}

export async function getLedgerBlocks(
  networkId: string,
  channelName: string,
  options: { limit?: number; before?: string } = {},
): Promise<LedgerBlockListResponse> {
  const query = new URLSearchParams();
  query.set('limit', String(options.limit ?? 10));
  if (options.before !== undefined) query.set('before', options.before);
  const blocks = LedgerBlockListResponseSchema.parse(
    await requestJson(
      `/api/v1/networks/${encodeURIComponent(networkId)}/channels/${encodeURIComponent(channelName)}/blocks?${query.toString()}`,
    ),
  );
  assertNetworkScope(networkId, blocks.networkId);
  if (blocks.channelName !== channelName) {
    throw new ControlPlaneApiError(
      '控制平面返回了其他通道的数据。',
      502,
      'channel_scope_mismatch',
    );
  }
  return blocks;
}

export async function getLedgerBlock(
  networkId: string,
  channelName: string,
  blockNumber: string,
): Promise<LedgerBlock> {
  const block = LedgerBlockSchema.parse(
    await requestJson(
      `/api/v1/networks/${encodeURIComponent(networkId)}/channels/${encodeURIComponent(channelName)}/blocks/${encodeURIComponent(blockNumber)}`,
    ),
  );
  assertNetworkScope(networkId, block.networkId);
  if (block.channelName !== channelName || block.number !== blockNumber) {
    throw new ControlPlaneApiError(
      '控制平面返回了其他区块的数据。',
      502,
      'block_scope_mismatch',
    );
  }
  return block;
}

export async function getJobs(networkId?: string): Promise<JobListResponse> {
  const query = networkId ? `?networkId=${encodeURIComponent(networkId)}` : '';
  return JobListResponseSchema.parse(await requestJson(`/api/v1/jobs${query}`));
}

export async function getJob(jobId: string): Promise<Job> {
  return JobSchema.parse(await requestJson(`/api/v1/jobs/${encodeURIComponent(jobId)}`));
}

export async function getJobEvents(jobId: string, afterId = 0): Promise<JobEventListResponse> {
  return JobEventListResponseSchema.parse(
    await requestJson(
      `/api/v1/jobs/${encodeURIComponent(jobId)}/events?after=${encodeURIComponent(afterId)}`,
    ),
  );
}

export async function createNetworkAction(request: {
  networkId: string;
  action: NetworkLifecycleAction;
  confirmation?: string;
}): Promise<Job> {
  return JobSchema.parse(
    await requestJson(
      `/api/v1/networks/${encodeURIComponent(request.networkId)}/actions/${request.action}`,
      {
        method: 'POST',
        body: JSON.stringify(
          request.confirmation ? { confirmation: request.confirmation } : {},
        ),
      },
    ),
  );
}

export async function cancelJob(jobId: string): Promise<Job> {
  return JobSchema.parse(
    await requestJson(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    }),
  );
}

export function subscribeToJobEvents(
  jobId: string,
  onEvent: (event: JobEvent) => void,
): () => void {
  const source = new EventSource(
    `${apiBaseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/events`,
  );
  source.onmessage = (message) => {
    try {
      onEvent(JobEventSchema.parse(JSON.parse(message.data)));
    } catch {
      // Ignore malformed events; the regular job queries remain the source of truth.
    }
  };
  return () => source.close();
}

function assertNetworkScope(requestedNetworkId: string, responseNetworkId: string): void {
  if (requestedNetworkId !== responseNetworkId) {
    throw new ControlPlaneApiError(
      '控制平面返回了其他网络的数据。',
      502,
      'network_scope_mismatch',
    );
  }
}
