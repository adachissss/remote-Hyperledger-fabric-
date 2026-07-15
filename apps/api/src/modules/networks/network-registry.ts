import type { NetworkSummary } from '@plus-fabric/shared';

export interface NetworkRegistry {
  list(): Promise<NetworkSummary[]>;
}

class EmptyNetworkRegistry implements NetworkRegistry {
  async list(): Promise<NetworkSummary[]> {
    return [];
  }
}

export function createNetworkRegistry(): NetworkRegistry {
  return new EmptyNetworkRegistry();
}
