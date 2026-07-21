import {
  CreateManagedNetworkRequestSchema,
  ImportNetworkRequestSchema,
  JobIdSchema,
  NetworkIdSchema,
  NetworkScriptActionSchema,
} from '@plus-fabric/shared';

import { ControlPlaneClient } from './api-client.js';
import { CliUsageError, hasFlag, readOption, type GlobalOptions } from './arguments.js';
import { loadConfigurationFile } from './configuration-file.js';
import {
  printHealth,
  printJob,
  printJobEvent,
  printJobFinished,
  printJobs,
  printJobStarted,
  printNetwork,
  printNetworkDiscoveries,
  printNetworks,
  type OutputWriter,
} from './output.js';
import { followJob, jobExitCode } from './job-follow.js';

export async function runCommand(
  options: GlobalOptions,
  client: ControlPlaneClient,
  writer: OutputWriter,
): Promise<number | undefined> {
  const [group, action, ...args] = options.command;

  if (group === 'health' && action === undefined) {
    printHealth(await client.getHealth(), options.output, writer);
    return;
  }

  if (group === 'network' && action === 'list') {
    printNetworks(await client.getNetworks(), options.output, writer);
    return;
  }

  if (group === 'network' && action === 'discover') {
    printNetworkDiscoveries(
      await client.getNetworkDiscoveries(),
      options.output,
      writer,
    );
    return;
  }

  if (group === 'network' && action === 'create') {
    const filePath = requireOption(args, '--file');
    const request = CreateManagedNetworkRequestSchema.parse(
      await loadConfigurationFile(filePath),
    );
    printNetwork(await client.createManagedNetwork(request), options.output, writer);
    return;
  }

  if (group === 'network' && action === 'import') {
    const filePath = requireOption(args, '--file');
    const request = ImportNetworkRequestSchema.parse(await loadConfigurationFile(filePath));
    printNetwork(await client.importNetwork(request), options.output, writer);
    return;
  }

  if (group === 'network' && NetworkScriptActionSchema.safeParse(action).success) {
    const networkId = NetworkIdSchema.parse(args[0]);
    const scriptAction = NetworkScriptActionSchema.parse(action);
    if (scriptAction === 'down' && !hasFlag(args, '--yes')) {
      throw new CliUsageError('network down 会清理运行资源，请增加 --yes 确认。');
    }
    const job = await client.createNetworkAction(
      networkId,
      scriptAction,
      scriptAction === 'down' ? networkId : undefined,
    );
    return runOrDetachJob(job, args, options, client, writer);
  }

  if (group === 'network' && action === 'delete') {
    const networkId = NetworkIdSchema.parse(args[0]);
    if (!hasFlag(args, '--yes')) {
      throw new CliUsageError('network delete 会彻底删除网络，请增加 --yes 确认。');
    }
    return runOrDetachJob(
      await client.deleteNetwork(networkId, networkId),
      args,
      options,
      client,
      writer,
    );
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

  if (group === 'job' && action === 'follow') {
    const jobId = JobIdSchema.parse(args[0]);
    return followExistingJob(jobId, options, client, writer);
  }

  if (group === 'job' && action === 'cancel') {
    const jobId = JobIdSchema.parse(args[0]);
    const job = await client.cancelJob(jobId);
    return runOrDetachJob(job, args, options, client, writer);
  }

  throw new CliUsageError('无法识别命令，请运行 pfctl --help 查看用法。');
}

async function runOrDetachJob(
  job: Awaited<ReturnType<ControlPlaneClient['getJob']>>,
  args: string[],
  options: GlobalOptions,
  client: ControlPlaneClient,
  writer: OutputWriter,
): Promise<number | undefined> {
  if (hasFlag(args, '--detach')) {
    printJob(job, options.output, writer);
    return;
  }
  printJobStarted(job, options.output, writer);
  return followExistingJob(job.id, options, client, writer);
}

async function followExistingJob(
  jobId: string,
  options: GlobalOptions,
  client: ControlPlaneClient,
  writer: OutputWriter,
): Promise<number> {
  const job = await followJob(client, jobId, {
    onEvent: (event) => printJobEvent(event, options.output, writer),
  });
  printJobFinished(job, options.output, writer);
  return jobExitCode(job);
}

function requireOption(args: string[], name: string): string {
  const value = readOption(args, name);
  if (!value) throw new CliUsageError(`${name} 是必填参数。`);
  return value;
}
