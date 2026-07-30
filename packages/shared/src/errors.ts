export class TernError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "TernError";
  }
}

export class ValidationError extends TernError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
  }
}

export class SecurityError extends TernError {
  constructor(message: string) {
    super(message, "SECURITY_ERROR");
  }
}
