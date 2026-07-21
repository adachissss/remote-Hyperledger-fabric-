import {
  CreateManagedNetworkRequestSchema,
  HealthResponseSchema,
  ImportNetworkRequestSchema,
  ImportNetworkDiscoveryRequestSchema,
  JobEventListResponseSchema,
  JobEventSchema,
  JobListResponseSchema,
  JobSchema,
  NetworkListResponseSchema,
  NetworkDiscoveryListResponseSchema,
  NetworkSummarySchema,
  type CreateManagedNetworkRequest,
  type HealthResponse,
  type ImportNetworkRequest,
  type ImportNetworkDiscoveryRequest,
  type Job,
  type JobEvent,
  type JobEventListResponse,
  type JobListResponse,
  type NetworkListResponse,
  type NetworkDiscoveryListResponse,
  type NetworkScriptAction,
  type NetworkSummary,
} from '@plus-fabric/shared';

type ResponseParser<T> = {
  parse(value: unknown): T;
};

export type ControlPlaneErrorPayload = {
  error?: unknown;
  message?: unknown;
  issues?: unknown;
};

export class ControlPlaneClientError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly issues: unknown = null,
  ) {
    super(message);
    this.name = 'ControlPlaneClientError';
  }
}

export class ControlPlaneClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  getHealth(): Promise<HealthResponse> {
    return this.request('/api/v1/system/health', HealthResponseSchema);
  }

  getNetworks(): Promise<NetworkListResponse> {
    return this.request('/api/v1/networks', NetworkListResponseSchema);
  }

  getNetworkDiscoveries(): Promise<NetworkDiscoveryListResponse> {
    return this.request(
      '/api/v1/networks/discoveries',
      NetworkDiscoveryListResponseSchema,
    );
  }

  createManagedNetwork(request: CreateManagedNetworkRequest): Promise<NetworkSummary> {
    const payload = CreateManagedNetworkRequestSchema.parse(request);
    return this.request('/api/v1/networks', NetworkSummarySchema, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  importNetwork(request: ImportNetworkRequest): Promise<NetworkSummary> {
    const payload = ImportNetworkRequestSchema.parse(request);
    return this.request('/api/v1/networks/import', NetworkSummarySchema, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  importNetworkDiscovery(
    discoveryNetworkId: string,
    request: ImportNetworkDiscoveryRequest,
  ): Promise<NetworkSummary> {
    const payload = ImportNetworkDiscoveryRequestSchema.parse(request);
    return this.request(
      `/api/v1/networks/discoveries/${encodeURIComponent(discoveryNetworkId)}/import`,
      NetworkSummarySchema,
      { method: 'POST', body: JSON.stringify(payload) },
    );
  }

  createNetworkAction(
    networkId: string,
    action: NetworkScriptAction,
    confirmation?: string,
  ): Promise<Job> {
    return this.request(
      `/api/v1/networks/${encodeURIComponent(networkId)}/actions/${action}`,
      JobSchema,
      {
        method: 'POST',
        body: JSON.stringify(confirmation ? { confirmation } : {}),
      },
    );
  }

  deleteNetwork(networkId: string, confirmation: string): Promise<Job> {
    return this.request(`/api/v1/networks/${encodeURIComponent(networkId)}`, JobSchema, {
      method: 'DELETE',
      body: JSON.stringify({ confirmation }),
    });
  }

  getJobs(networkId?: string): Promise<JobListResponse> {
    const query = networkId ? `?networkId=${encodeURIComponent(networkId)}` : '';
    return this.request(`/api/v1/jobs${query}`, JobListResponseSchema);
  }

  getJob(jobId: string): Promise<Job> {
    return this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}`, JobSchema);
  }

  getJobEvents(jobId: string, afterId = 0): Promise<JobEventListResponse> {
    return this.request(
      `/api/v1/jobs/${encodeURIComponent(jobId)}/events?after=${afterId}`,
      JobEventListResponseSchema,
    );
  }

  cancelJob(jobId: string): Promise<Job> {
    return this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, JobSchema, {
      method: 'POST',
    });
  }

  async streamJobEvents(
    jobId: string,
    afterId: number,
    onEvent: (event: JobEvent) => void,
    signal: AbortSignal,
  ): Promise<number> {
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${this.baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/events?after=${afterId}`,
        {
          headers: {
            Accept: 'text/event-stream',
            'Last-Event-ID': String(afterId),
          },
          signal,
        },
      );
    } catch (error) {
      if (signal.aborted) return afterId;
      throw new ControlPlaneClientError(
        `无法订阅作业日志：${error instanceof Error ? error.message : String(error)}`,
        null,
        'event_stream_failed',
      );
    }

    if (!response.ok) {
      const payload = (await readJson(response)) as ControlPlaneErrorPayload | null;
      throw new ControlPlaneClientError(
        typeof payload?.message === 'string'
          ? payload.message
          : `订阅作业日志失败，状态码 ${response.status}。`,
        response.status,
        typeof payload?.error === 'string' ? payload.error : 'event_stream_failed',
      );
    }
    if (!response.body) {
      throw new ControlPlaneClientError(
        '控制平面没有返回作业日志流。',
        response.status,
        'empty_event_stream',
      );
    }

    return consumeEventStream(response.body, afterId, onEvent, signal);
  }

  async request<T>(
    path: string,
    parser: ResponseParser<T>,
    init: RequestInit = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new ControlPlaneClientError(
        `无法连接控制平面 ${this.baseUrl}：${error instanceof Error ? error.message : String(error)}`,
        null,
        'connection_failed',
      );
    }

    const payload = await readJson(response);
    if (!response.ok) {
      const errorPayload = payload as ControlPlaneErrorPayload | null;
      throw new ControlPlaneClientError(
        typeof errorPayload?.message === 'string'
          ? errorPayload.message
          : `控制平面请求失败，状态码 ${response.status}。`,
        response.status,
        typeof errorPayload?.error === 'string' ? errorPayload.error : null,
        errorPayload?.issues,
      );
    }

    try {
      return parser.parse(payload);
    } catch (error) {
      throw new ControlPlaneClientError(
        `控制平面返回了无法识别的数据：${error instanceof Error ? error.message : String(error)}`,
        response.status,
        'invalid_response',
      );
    }
  }
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!normalized) {
    throw new ControlPlaneClientError('控制平面地址不能为空。', null, 'invalid_api_url');
  }
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported');
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new ControlPlaneClientError(
      `控制平面地址无效：${value}`,
      null,
      'invalid_api_url',
    );
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ControlPlaneClientError(
      `控制平面返回了非 JSON 响应，状态码 ${response.status}。`,
      response.status,
      'invalid_json_response',
    );
  }
}

export async function consumeEventStream(
  stream: ReadableStream<Uint8Array>,
  afterId: number,
  onEvent: (event: JobEvent) => void,
  signal?: AbortSignal,
): Promise<number> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let cursor = afterId;

  try {
    while (!signal?.aborted) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEventFrame(frame);
        if (event && event.id > cursor) {
          cursor = event.id;
          onEvent(event);
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  return cursor;
}

function parseEventFrame(frame: string): JobEvent | null {
  const dataLines = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  try {
    return JobEventSchema.parse(JSON.parse(dataLines.join('\n')));
  } catch {
    return null;
  }
}
