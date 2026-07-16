import { spawn } from 'node:child_process';

import type { JobLogStream, NetworkLifecycleAction } from '@plus-fabric/shared';

export type ProcessLogLine = {
  stream: Extract<JobLogStream, 'stdout' | 'stderr'>;
  message: string;
};

export type LifecycleProcessRequest = {
  executable: string;
  action: NetworkLifecycleAction;
  cwd: string;
  configPath: string;
  composeProject: string;
  timeoutMs: number;
  signal: AbortSignal;
  onLine(line: ProcessLogLine): Promise<void> | void;
};

export type LifecycleProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
  timedOut: boolean;
};

export interface LifecycleProcessRunner {
  run(request: LifecycleProcessRequest): Promise<LifecycleProcessResult>;
}

export class NodeLifecycleProcessRunner implements LifecycleProcessRunner {
  run(request: LifecycleProcessRequest): Promise<LifecycleProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, [request.action], {
        cwd: request.cwd,
        env: {
          ...process.env,
          CONFIG_FILE: request.configPath,
          COMPOSE_PROJECT_NAME: request.composeProject,
        },
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutSanitizer = new LogSanitizer();
      const stderrSanitizer = new LogSanitizer();
      let settled = false;
      let timedOut = false;
      let cancelled = request.signal.aborted;
      let pendingWrites = Promise.resolve();
      let writeError: unknown;
      let forceKillTimer: NodeJS.Timeout | null = null;

      const requestTermination = (cancelRequest: boolean) => {
        if (cancelRequest && !timedOut) cancelled = true;
        terminateProcess(child.pid, 'SIGTERM');
        forceKillTimer ??= setTimeout(() => terminateProcess(child.pid, 'SIGKILL'), 5_000);
        forceKillTimer.unref();
      };

      const enqueue = (stream: ProcessLogLine['stream'], message: string) => {
        const sanitizer = stream === 'stdout' ? stdoutSanitizer : stderrSanitizer;
        const sanitized = sanitizer.sanitize(message);
        if (sanitized === null) return;
        pendingWrites = pendingWrites
          .then(() => request.onLine({ stream, message: sanitized }))
          .catch((error: unknown) => {
            writeError ??= error;
            requestTermination(false);
          });
      };
      const flushStdout = pipeLines(child.stdout, (message) => enqueue('stdout', message));
      const flushStderr = pipeLines(child.stderr, (message) => enqueue('stderr', message));

      const terminate = () => {
        requestTermination(true);
      };
      request.signal.addEventListener('abort', terminate, { once: true });
      if (request.signal.aborted) terminate();

      const timeout = setTimeout(() => {
        timedOut = true;
        requestTermination(false);
      }, request.timeoutMs);
      timeout.unref();

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        request.signal.removeEventListener('abort', terminate);
        reject(error);
      });

      child.once('close', async (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        request.signal.removeEventListener('abort', terminate);
        flushStdout();
        flushStderr();
        await pendingWrites;
        if (writeError) {
          reject(writeError);
          return;
        }
        resolve({ exitCode, signal, cancelled, timedOut });
      });
    });
  }
}

function pipeLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
  return () => {
    if (buffered) onLine(buffered);
    buffered = '';
  };
}

function terminateProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch {
    // The process may have already exited.
  }
}

class LogSanitizer {
  #insidePrivateKey = false;

  sanitize(value: string): string | null {
    let line = value.replace(
      // eslint-disable-next-line no-control-regex
      /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
      '',
    );

    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) {
      this.#insidePrivateKey = true;
      return '[已隐藏私钥内容]';
    }
    if (this.#insidePrivateKey) {
      if (/-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) {
        this.#insidePrivateKey = false;
      }
      return null;
    }

    line = line.replace(
      /(password|passwd|secret|token|authorization)(\s*[:=]\s*)([^\s,;]+)/gi,
      '$1$2[已隐藏]',
    );
    line = line.replace(/(https?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[已隐藏]@');
    return line;
  }
}
