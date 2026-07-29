
import { readFile } from "fs/promises";
import yaml from "js-yaml";
import { SpecLoader, OpenApiDocument } from "./interfaces";

const MAX_SPEC_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_REMOTE_SIZE = 50 * 1024 * 1024; // 50MB

export class DefaultSpecLoader implements SpecLoader {
  async load(source: string): Promise<OpenApiDocument> {
    let raw: string;
    if (source.startsWith("http://") || source.startsWith("https://")) {
      raw = await this.fetchRemote(source);
    } else {
      const resolved = this.resolveLocalPath(source);
      const stat = await readFile(resolved).then(buf => buf.length);
      if (stat > MAX_SPEC_SIZE) throw new Error(`Spec file exceeds ${MAX_SPEC_SIZE} bytes: ${source}`);
      raw = await readFile(resolved, "utf8");
    }
    return this.parse(raw);
  }

  private async fetchRemote(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch spec: ${res.status}`);
    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_REMOTE_SIZE) throw new Error(`Remote spec exceeds ${MAX_REMOTE_SIZE} bytes`);
    const raw = await res.text();
    if (raw.length > MAX_REMOTE_SIZE) throw new Error(`Remote spec exceeds ${MAX_REMOTE_SIZE} bytes`);
    return raw;
  }

  private resolveLocalPath(source: string): string {
    const resolved = source.replace(/\.\./g, ""); // Prevent path traversal
    if (resolved !== source) throw new Error("Path traversal detected in spec path");
    return resolved;
  }

  private parse(raw: string): OpenApiDocument {
    const isYaml = sourceIsYaml(raw);
    const parsed = isYaml ? yaml.load(raw, { schema: yaml.CORE_SCHEMA, json: true }) : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid OpenAPI document");
    const doc = parsed as OpenApiDocument;
    if (!doc.openapi || !doc.openapi.startsWith("3.")) {
      throw new Error(`Unsupported OpenAPI version: ${doc.openapi}`);
    }
    return doc;
  }
}

export function loadFromString(raw: string): OpenApiDocument {
  const isYaml = sourceIsYaml(raw);
  const parsed = isYaml ? yaml.load(raw, { schema: yaml.CORE_SCHEMA, json: true }) : JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid OpenAPI document");
  const doc = parsed as OpenApiDocument;
  if (!doc.openapi || !doc.openapi.startsWith("3.")) {
    throw new Error(`Unsupported OpenAPI version: ${doc.openapi}`);
  }
  return doc;
}

function sourceIsYaml(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  return true;
}
