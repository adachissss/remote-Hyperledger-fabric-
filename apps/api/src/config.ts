import { z } from 'zod';

const EnvironmentSchema = z.object({
  CONTROL_PLANE_HOST: z.string().default('127.0.0.1'),
  CONTROL_PLANE_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  CONTROL_PLANE_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  CONTROL_PLANE_CORS_ORIGIN: z.string().default('http://localhost:5173'),
});

export type AppConfig = {
  host: string;
  port: number;
  logLevel: z.infer<typeof EnvironmentSchema>['CONTROL_PLANE_LOG_LEVEL'];
  corsOrigins: string[];
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvironmentSchema.parse(environment);

  return {
    host: parsed.CONTROL_PLANE_HOST,
    port: parsed.CONTROL_PLANE_PORT,
    logLevel: parsed.CONTROL_PLANE_LOG_LEVEL,
    corsOrigins: parsed.CONTROL_PLANE_CORS_ORIGIN.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}
