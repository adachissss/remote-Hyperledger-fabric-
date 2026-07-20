#!/usr/bin/env node

import { ZodError } from 'zod';

import { ControlPlaneClient, ControlPlaneClientError } from './api-client.js';
import { CliUsageError, parseGlobalOptions } from './arguments.js';
import { runCommand } from './commands.js';
import { consoleWriter, type OutputWriter } from './output.js';

const VERSION = '0.1.0';

export async function main(
  argv: string[] = process.argv.slice(2),
  writer: OutputWriter = consoleWriter,
): Promise<number> {
  try {
    const options = parseGlobalOptions(argv);
    if (options.version) {
      writer.write(`pfctl ${VERSION}`);
      return 0;
    }
    if (options.help || options.command.length === 0) {
      writer.write(HELP_TEXT);
      return 0;
    }

    const client = new ControlPlaneClient(options.apiUrl);
    await runCommand(options, client, writer);
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      writer.error(`参数错误：${error.message}`);
      return 3;
    }
    if (error instanceof ControlPlaneClientError) {
      writer.error(`控制平面错误${error.code ? ` [${error.code}]` : ''}：${error.message}`);
      if (error.issues) writer.error(JSON.stringify(error.issues, null, 2));
      return 3;
    }
    if (error instanceof ZodError) {
      writer.error(`输入或响应校验失败：${error.issues.map((issue) => issue.message).join('；')}`);
      return 3;
    }
    writer.error(`未预期错误：${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }
}

const HELP_TEXT = `pfctl - plus-fabric 终端控制工具

用法：
  pfctl [--api <url>] [--output human|json] <命令>

基础命令：
  health                         检查控制平面健康状态
  network list                   查看已注册网络
  network create --file <path>   通过 YAML/JSON 创建托管网络
  network import --file <path>   导入已有网络工作区
  network up <id>                启动网络
  network stop <id>              暂停网络
  network restart <id>           恢复网络
  network down <id> --yes        清理网络运行资源
  network delete <id> --yes      彻底删除网络
  job list [--network <id>]      查看作业
  job get <job-id>               查看作业详情

全局选项：
  --api <url>                    API 地址，默认 http://127.0.0.1:4100
  --output human|json            输出格式
  --json                         等价于 --output json
  -h, --help                     显示帮助
  -v, --version                  显示版本`;

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
