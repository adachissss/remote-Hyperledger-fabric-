import { createConnection } from 'node:net';

export type ServiceProbeTarget = {
  host: string;
  port: number;
  timeoutMs: number;
};

export type ServiceProbeResult = {
  reachable: boolean;
  latencyMs: number | null;
};

export interface ServiceProbe {
  probe(target: ServiceProbeTarget): Promise<ServiceProbeResult>;
}

export class TcpServiceProbe implements ServiceProbe {
  probe(target: ServiceProbeTarget): Promise<ServiceProbeResult> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const socket = createConnection({ host: target.host, port: target.port });
      let settled = false;

      const finish = (reachable: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({
          reachable,
          latencyMs: reachable ? Date.now() - startedAt : null,
        });
      };

      socket.setTimeout(target.timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
  }
}
