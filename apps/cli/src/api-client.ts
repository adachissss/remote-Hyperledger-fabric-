import {
  CreateManagedNetworkRequestSchema,
  HealthResponseSchema,
  ImportNetworkRequestSchema,
  JobEventListResponseSchema,
  JobListResponseSchema,
  JobSchema,
  NetworkListResponseSchema,
  NetworkSummarySchema,
  type CreateManagedNetworkRequest,
  type HealthResponse,
  type ImportNetworkRequest,
  type Job,
  type JobEventListResponse,
  type JobListResponse,
  type NetworkListResponse,
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
