import { JobIdSchema, NetworkIdSchema } from '@plus-fabric/shared';

import { ControlPlaneClient } from './api-client.js';
import { CliUsageError, readOption, type GlobalOptions } from './arguments.js';
import {
  printHealth,
  printJob,
  printJobs,
  printNetworks,
  type OutputWriter,
} from './output.js';

export async function runCommand(
  options: GlobalOptions,
  client: ControlPlaneClient,
  writer: OutputWriter,
): Promise<void> {
  const [group, action, ...args] = options.command;

  if (group === 'health' && action === undefined) {
    printHealth(await client.getHealth(), options.output, writer);
    return;
  }

  if (group === 'network' && action === 'list') {
    printNetworks(await client.getNetworks(), options.output, writer);
    return;
  }

  if (group === 'job' && action === 'list') {
    const networkId = readOption(args, '--network');
    if (networkId) NetworkIdSchema.parse(networkId);
    printJobs(await client.getJobs(networkId), options.output, writer);
    return;
  }

  if (group === 'job' && action === 'get') {
    const jobId = JobIdSchema.parse(args[0]);
    printJob(await client.getJob(jobId), options.output, writer);
    return;
  }

  throw new CliUsageError('无法识别命令，请运行 pfctl --help 查看用法。');
}
