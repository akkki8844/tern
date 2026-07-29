
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.string().default("3000").transform(Number),
  DATABASE_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/tern?schema=public"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().default("demo-secret"),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  FIREWORKS_API_KEY: z.string().optional(),
  FIREWORKS_MODEL: z.string().default("accounts/fireworks/models/kimi-k2p6"),
  FIREWORKS_BASE_URL: z.string().default("https://api.fireworks.ai/inference/v1"),
  NEXTAUTH_SECRET: z.string().default("demo-nextauth-secret"),
  NEXTAUTH_URL: z.string().default("http://localhost:3000"),
  ENCRYPTION_KEY: z.string().optional(),
  DEMO_MODE: z.string().default("false").transform(v => v === "true"),
  LOG_LEVEL: z.string().default("info"),
  SANDBOX_TIMEOUT_MS: z.string().default("300000").transform(Number),
  SANDBOX_MEMORY_MB: z.string().default("2048").transform(Number),
  SANDBOX_CPU_LIMIT: z.string().default("2").transform(Number),
  RATE_LIMIT_WINDOW_MS: z.string().default("60000").transform(Number),
  RATE_LIMIT_MAX_REQUESTS: z.string().default("100").transform(Number),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;
export function getConfig(): Config {
  if (cached) return cached;
  cached = schema.parse(process.env);
  return cached;
}

export function resetConfig(): void { cached = null; }

export function isProductionMode(): boolean {
  const c = getConfig();
  return !c.DEMO_MODE && Boolean(c.GITHUB_APP_ID && c.GITHUB_PRIVATE_KEY);
}
