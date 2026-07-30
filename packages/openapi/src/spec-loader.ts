
import { readFile } from "fs/promises";
import { isValidUrl } from "@tern/shared";
import yaml from "js-yaml";
import { SpecLoader, OpenApiDocument } from "./interfaces.js";

const MAX_LOCAL_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_REMOTE_SIZE = 50 * 1024 * 1024; // 50MB

export class DefaultSpecLoader implements SpecLoader {
  async load(source: string): Promise<OpenApiDocument> {
    const raw = await this.loadRaw(source);
    return parseSpec(raw);
  }

  private async loadRaw(source: string): Promise<string> {
    if (!isLocalPath(source) && isValidUrl(source)) return this.fetchRemote(source);
    const resolved = sanitizeLocalPath(source);
    const buffer = await readFile(resolved);
    if (buffer.length > MAX_LOCAL_SIZE) throw new Error(`Spec exceeds ${MAX_LOCAL_SIZE} bytes: ${source}`);
    return buffer.toString("utf8");
  }

  private async fetchRemote(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch spec: ${res.status} ${res.statusText}`);
    const length = parseContentLength(res.headers.get("content-length"));
    if (length && length > MAX_REMOTE_SIZE) throw new Error(`Remote spec exceeds ${MAX_REMOTE_SIZE} bytes`);
    const raw = await res.text();
    if (raw.length > MAX_REMOTE_SIZE) throw new Error(`Remote spec exceeds ${MAX_REMOTE_SIZE} bytes`);
    return raw;
  }
}

export function loadFromString(raw: string): OpenApiDocument {
  return parseSpec(raw);
}

function parseSpec(raw: string): OpenApiDocument {
  const parsed = looksLikeYaml(raw) ? yaml.load(raw, { schema: yaml.CORE_SCHEMA, json: true }) : JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OpenAPI document must be an object");
  }
  const doc = parsed as OpenApiDocument;
  if (!doc.openapi || !doc.openapi.startsWith("3.")) {
    throw new Error(`Unsupported OpenAPI version: ${String(doc.openapi)}`);
  }
  if (!doc.paths || typeof doc.paths !== "object") {
    throw new Error("OpenAPI document missing paths object");
  }
  return doc;
}

export function sanitizeLocalPath(source: string): string {
  if (source.includes("\u0000")) throw new Error("Invalid null byte in path");
  const normalized = source.replace(/\+/g, "/").replace(/\/\/+/g, "/");
  const resolved = normalized.replace(/\.\./g, "");
  if (resolved !== normalized) throw new Error("Path traversal detected in spec path");
  return resolved;
}

function isLocalPath(source: string): boolean {
  return source.startsWith("/") || source.startsWith("./") || source.startsWith("../") || /^[A-Za-z]:[/\\]/.test(source);
}

function looksLikeYaml(raw: string): boolean {
  const trimmed = raw.trim();
  return !trimmed.startsWith("{") && !trimmed.startsWith("[");
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
