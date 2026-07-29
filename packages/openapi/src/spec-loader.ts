
import { readFile } from "fs/promises";
import yaml from "js-yaml";
import { SpecLoader, OpenApiDocument } from "./interfaces";

export class DefaultSpecLoader implements SpecLoader {
  async load(source: string): Promise<OpenApiDocument> {
    let raw: string;
    if (source.startsWith("http://") || source.startsWith("https://")) {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`Failed to fetch spec: ${res.status}`);
      raw = await res.text();
    } else {
      raw = await readFile(source, "utf8");
    }
    const parsed = source.endsWith(".yaml") || source.endsWith(".yml") || raw.trim().startsWith("openapi:")
      ? yaml.load(raw)
      : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid OpenAPI document");
    return parsed as OpenApiDocument;
  }
}

export function loadFromString(raw: string): OpenApiDocument {
  const parsed = raw.trim().startsWith("openapi:") ? yaml.load(raw) : JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid OpenAPI document");
  return parsed as OpenApiDocument;
}
