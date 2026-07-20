import type {
  HealthResponse,
  Job,
  JobListResponse,
  NetworkListResponse,
  NetworkSummary,
} from '@plus-fabric/shared';

import type { OutputMode } from './arguments.js';

export type OutputWriter = {
  write(message: string): void;
  error(message: string): void;
};

export const consoleWriter: OutputWriter = {
  write: (message) => process.stdout.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
};

export function printHealth(health: HealthResponse, mode: OutputMode, writer: OutputWriter): void {
  if (mode === 'json') return printJson(health, writer);
  writer.write(`控制平面：${health.status === 'ok' ? '正常' : '降级'}`);
  writer.write(`服务版本：${health.version}`);
  writer.write(`运行时间：${Math.floor(health.uptimeSeconds)} 秒`);
  writer.write(`API 时间：${health.timestamp}`);
}

export function printNetworks(
  response: NetworkListResponse,
  mode: OutputMode,
  writer: OutputWriter,
): void {
  if (mode === 'json') return printJson(response, writer);
  if (response.items.length === 0) {
    writer.write('当前没有已注册网络。');
    return;
  }
  writer.write(renderTable(
    ['网络 ID', '名称', '来源', '状态', '组织', '通道', '节点'],
    response.items.map((network) => [
      network.id,
      network.displayName,
      network.managementMode === 'managed' ? '托管' : '导入',
      network.status,
      String(network.organizationCount),
      String(network.channelCount),
      String(network.nodeCount),
    ]),
  ));
}

export function printNetwork(
  network: NetworkSummary,
  mode: OutputMode,
  writer: OutputWriter,
): void {
  if (mode === 'json') return printJson(network, writer);
  writer.write(`网络已注册：${network.displayName} (${network.id})`);
  writer.write(`来源：${network.managementMode === 'managed' ? '托管创建' : '外部导入'}`);
  writer.write(`当前状态：${network.status}`);
  writer.write(`组织/通道/节点：${network.organizationCount}/${network.channelCount}/${network.nodeCount}`);
}

export function printJobs(response: JobListResponse, mode: OutputMode, writer: OutputWriter): void {
  if (mode === 'json') return printJson(response, writer);
  if (response.items.length === 0) {
    writer.write('当前没有作业记录。');
    return;
  }
  writer.write(renderTable(
    ['作业 ID', '网络', '操作', '状态', '创建时间'],
    response.items.map((job) => [job.id, job.networkId, job.action, job.status, job.createdAt]),
  ));
}

export function printJob(job: Job, mode: OutputMode, writer: OutputWriter): void {
  if (mode === 'json') return printJson(job, writer);
  writer.write(`作业 ID：${job.id}`);
  writer.write(`网络：${job.networkId}`);
  writer.write(`操作：${job.action}`);
  writer.write(`状态：${job.status}`);
  writer.write(`退出码：${job.exitCode ?? '-'}`);
  if (job.errorMessage) writer.write(`错误：${job.errorMessage}`);
  if (job.steps.length > 0) {
    writer.write('步骤：');
    for (const step of job.steps) writer.write(`  ${step.sequence}. [${step.status}] ${step.name}`);
  }
}

export function printJson(value: unknown, writer: OutputWriter): void {
  writer.write(JSON.stringify(value, null, 2));
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (row: string[]) =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join('  ');
  return [renderRow(headers), renderRow(widths.map((width) => '-'.repeat(width))), ...rows.map(renderRow)].join('\n');
}
