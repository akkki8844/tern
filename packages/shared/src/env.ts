import { z } from "zod";
import { TernError } from "@/packages/shared/src/errors";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_PRIVATE_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  LLM_PROVIDER: z.string().optional(),
  TERN_DEMO_MODE: z.enum(["true", "false"]).default("true"),
});

export type AppEnv = z.infer<typeof envSchema>;

export function getEnv(): AppEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new TernError("CONFIG_ERROR", "Invalid environment variables", 500, {
      issues: parsed.error.issues,
    });
  }

  return parsed.data;
}

export function requireSecrets(keys: Array<keyof AppEnv>) {
  const env = getEnv();
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new TernError("CONFIG_ERROR", `Missing required secrets: ${missing.join(", ")}`, 500);
  }
}
