
import { z } from "zod";

export function readEnv<T extends z.ZodTypeAny>(schema: T, overrides?: Record<string, string>): z.infer<T> {
  const input = { ...process.env, ...(overrides || {}) };
  return schema.parse(input);
}

export function safeReadEnv<T extends z.ZodTypeAny>(schema: T, overrides?: Record<string, string>): { success: true; data: z.infer<T> } | { success: false; errors: z.ZodError } {
  const input = { ...process.env, ...(overrides || {}) };
  const parsed = schema.safeParse(input);
  if (parsed.success) return { success: true, data: parsed.data };
  return { success: false, errors: parsed.error };
}
