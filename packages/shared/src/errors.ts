export type ErrorCode =
  | "CONFIG_ERROR"
  | "AUTH_ERROR"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR";

export class TernError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, status = 500, details?: Record<string, unknown>) {
    super(message);
    this.name = "TernError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function toTernError(error: unknown): TernError {
  if (error instanceof TernError) {
    return error;
  }

  return new TernError("INTERNAL_ERROR", error instanceof Error ? error.message : "Unexpected error", 500);
}
