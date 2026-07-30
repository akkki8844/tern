
export interface Config {
  NODE_ENV: "development" | "test" | "production";
  LOG_LEVEL: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  FIREWORKS_API_KEY?: string;
  FIREWORKS_BASE_URL: string;
  FIREWORKS_MODEL: string;
  ENCRYPTION_KEY?: string;
  DEMO_MODE?: boolean;
  SANDBOX_TIMEOUT_MS: number;
  SANDBOX_MEMORY_MB: number;
  SANDBOX_CPU_LIMIT: number;
}

export function getConfig(): Config {
  return {
    NODE_ENV: (process.env.NODE_ENV as any) || "development",
    LOG_LEVEL: process.env.LOG_LEVEL || "info",
    DATABASE_URL: process.env.DATABASE_URL || "postgresql://localhost:5432/tern",
    REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
    GITHUB_APP_ID: process.env.GITHUB_APP_ID || "",
    GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY || "",
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET || "",
    FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY,
    FIREWORKS_BASE_URL: process.env.FIREWORKS_BASE_URL || "https://api.fireworks.ai/inference/v1",
    FIREWORKS_MODEL: process.env.FIREWORKS_MODEL || "accounts/fireworks/models/llama-v3p1-70b-instruct",
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    DEMO_MODE: process.env.DEMO_MODE === "true",
    SANDBOX_TIMEOUT_MS: parseInt(process.env.SANDBOX_TIMEOUT_MS || "300000", 10),
    SANDBOX_MEMORY_MB: parseInt(process.env.SANDBOX_MEMORY_MB || "2048", 10),
    SANDBOX_CPU_LIMIT: parseInt(process.env.SANDBOX_CPU_LIMIT || "2", 10)
  };
}
