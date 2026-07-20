export type OutputMode = 'human' | 'json';

export type GlobalOptions = {
  apiUrl: string;
  output: OutputMode;
  help: boolean;
  version: boolean;
  command: string[];
};

const DEFAULT_API_URL = 'http://127.0.0.1:4100';

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export function parseGlobalOptions(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
): GlobalOptions {
  let apiUrl = environment.PLUS_FABRIC_API_URL ?? DEFAULT_API_URL;
  let output: OutputMode = 'human';
  let help = false;
  let version = false;
  const command: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--api') {
      apiUrl = requireValue(argv, ++index, '--api');
    } else if (argument?.startsWith('--api=')) {
      apiUrl = argument.slice('--api='.length);
    } else if (argument === '--output') {
      output = parseOutputMode(requireValue(argv, ++index, '--output'));
    } else if (argument?.startsWith('--output=')) {
      output = parseOutputMode(argument.slice('--output='.length));
    } else if (argument === '--json') {
      output = 'json';
    } else if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--version' || argument === '-v') {
      version = true;
    } else {
      command.push(argument ?? '');
    }
  }

  return { apiUrl, output, help, version, command };
}

export function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return requireValue(args, index + 1, name);
  const prefix = `${name}=`;
  const inline = args.find((argument) => argument.startsWith(prefix));
  return inline?.slice(prefix.length);
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseOutputMode(value: string): OutputMode {
  if (value === 'human' || value === 'json') return value;
  throw new CliUsageError(`--output 仅支持 human 或 json，收到：${value}`);
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new CliUsageError(`${option} 缺少参数。`);
  }
  return value;
}
