import { execFile } from 'node:child_process';

import { z } from 'zod';

const DockerInspectSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Config: z.object({
    Image: z.string().optional(),
  }),
  State: z.object({
    Status: z.string().optional(),
    Running: z.boolean().default(false),
    Paused: z.boolean().default(false),
    Restarting: z.boolean().default(false),
    StartedAt: z.string().optional(),
    FinishedAt: z.string().optional(),
    Health: z.object({ Status: z.string().optional() }).optional(),
  }),
  RestartCount: z.number().int().nonnegative().optional(),
  NetworkSettings: z.object({
    Networks: z.record(
      z.string(),
      z.object({
        IPAddress: z.string().optional(),
      }),
    ),
  }),
});

export type DockerRuntimeProbe = {
  available: boolean;
  reason: string | null;
};

export type DockerContainerObservation = {
  containerId: string;
  status: string | null;
  running: boolean;
  paused: boolean;
  restarting: boolean;
  health: string | null;
  image: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  restartCount: number;
  networkAttached: boolean;
  ipAddress: string | null;
};

export interface DockerRuntime {
  probe(): Promise<DockerRuntimeProbe>;
  inspectContainer(
    containerName: string,
    expectedNetwork: string,
  ): Promise<DockerContainerObservation | null>;
}

export class DockerCliRuntime implements DockerRuntime {
  async probe(): Promise<DockerRuntimeProbe> {
    try {
      await runDocker(['version', '--format', '{{.Server.Version}}']);
      return { available: true, reason: null };
    } catch (error) {
      return {
        available: false,
        reason: isCommandMissing(error)
          ? 'The Docker CLI is not installed on the control-plane host.'
          : 'The Docker daemon is unavailable to the control-plane process.',
      };
    }
  }

  async inspectContainer(
    containerName: string,
    expectedNetwork: string,
  ): Promise<DockerContainerObservation | null> {
    let stdout: string;
    try {
      ({ stdout } = await runDocker(['inspect', containerName]));
    } catch (error) {
      if (isMissingContainer(error)) return null;
      throw error;
    }

    const document = DockerInspectSchema.parse(
      z.array(z.unknown()).min(1).parse(JSON.parse(stdout))[0],
    );
    const expectedNetworkSettings = document.NetworkSettings.Networks[expectedNetwork];

    return {
      containerId: document.Id,
      status: document.State.Status ?? null,
      running: document.State.Running,
      paused: document.State.Paused,
      restarting: document.State.Restarting,
      health: document.State.Health?.Status ?? null,
      image: document.Config.Image ?? null,
      startedAt: normalizeDockerTimestamp(document.State.StartedAt),
      finishedAt: normalizeDockerTimestamp(document.State.FinishedAt),
      restartCount: document.RestartCount ?? 0,
      networkAttached: expectedNetworkSettings !== undefined,
      ipAddress: expectedNetworkSettings?.IPAddress || null,
    };
  }
}

type DockerCommandError = Error & {
  code?: string | number;
  stderr?: string;
};

function runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      args,
      { encoding: 'utf8', timeout: 5_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const commandError = error as DockerCommandError;
          commandError.stderr = stderr;
          reject(commandError);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function isCommandMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isMissingContainer(error: unknown): boolean {
  if (!(error instanceof Error) || !('stderr' in error) || typeof error.stderr !== 'string') {
    return false;
  }
  return /No such (object|container)/i.test(error.stderr);
}

function normalizeDockerTimestamp(value: string | undefined): string | null {
  if (!value || value.startsWith('0001-01-01')) return null;
  return value;
}
