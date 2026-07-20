import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { CliUsageError } from './arguments.js';

export async function loadConfigurationFile(filePath: string): Promise<unknown> {
  const absolutePath = path.resolve(filePath);
  let content: string;
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch (error) {
    throw new CliUsageError(
      `无法读取配置文件 ${absolutePath}：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const value = parseYaml(content) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('顶层必须是对象');
    }
    return value;
  } catch (error) {
    throw new CliUsageError(
      `无法解析配置文件 ${absolutePath}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
