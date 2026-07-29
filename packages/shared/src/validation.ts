
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isValidUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
}

export function assertNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || Number.isNaN(value)) throw new Error(`${name} must be a number`);
}

export function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(`${name} must be an object`);
}
