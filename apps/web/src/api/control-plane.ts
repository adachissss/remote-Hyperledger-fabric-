import {
  HealthResponseSchema,
  NetworkListResponseSchema,
  type HealthResponse,
  type NetworkListResponse,
} from '@plus-fabric/shared';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '';

async function requestJson(path: string): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Control plane request failed with status ${response.status}.`);
  }

  return response.json();
}

export async function getSystemHealth(): Promise<HealthResponse> {
  return HealthResponseSchema.parse(await requestJson('/api/v1/system/health'));
}

export async function getNetworks(): Promise<NetworkListResponse> {
  return NetworkListResponseSchema.parse(await requestJson('/api/v1/networks'));
}
