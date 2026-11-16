/**
 * Wrapper for values that must never be logged, serialised or interpolated by accident.
 *
 * `String(secret)`, `${secret}`, `JSON.stringify(secret)` and `util.inspect(secret)` all
 * yield `[REDACTED]`. The real value is only reachable through `.reveal()`.
 */
const REDACTED = "[REDACTED]";

export class Secret<T extends string = string> {
  readonly #value: T;
  readonly label: string;

  constructor(value: T, label: string) {
    this.#value = value;
    this.label = label;
  }

  /** Explicitly read the underlying value. Call sites are grep-able. */
  reveal(): T {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  get isEmpty(): boolean {
    return this.#value.length === 0;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  /** node:util.inspect hook so `console.log(secret)` cannot leak. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Secret(${this.label}) ${REDACTED}`;
  }
}

export function secret<T extends string>(value: T, label: string): Secret<T> {
  return new Secret(value, label);
}

export function isSecret(value: unknown): value is Secret {
  return value instanceof Secret;
}

/** Reveal a secret that may be undefined. */
export function revealOptional(value: Secret | undefined): string | undefined {
  return value?.reveal();
}
