
import pino from "pino";
import { getConfig } from "./config";

const root = pino({
  level: getConfig().LOG_LEVEL,
  transport: process.env.NODE_ENV === "development" ? { target: "pino-pretty", options: { colorize: true } } : undefined,
  redact: ["req.headers.authorization", "req.headers.cookie", "*.token", "*.secret", "*.privateKey", "*.apiKey", "*.*Token", "*.*Key", "*.*Secret"]
});

export function getLogger(name: string): pino.Logger {
  return root.child({ service: name });
}

export { root as logger };
