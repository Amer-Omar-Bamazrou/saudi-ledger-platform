/**
 * Typed application errors for the layered architecture (M6).
 *
 * Services and controllers `throw` these; the centralized `errorHandler`
 * middleware translates them to HTTP responses. Each carries a `statusCode`,
 * which is fully compatible with the pre-M6 convention of attaching a
 * `statusCode` property to a plain Error (e.g. the period-lock 423), so both
 * old and new code paths translate identically.
 */
export class AppError extends Error {
  readonly statusCode: number;
  /**
   * Optional structured response body. When set, the errorHandler sends this
   * object verbatim instead of `{ error: message }` — used to preserve rich
   * error responses that carry extra fields (e.g. `code`, `detail`).
   */
  readonly payload?: Record<string, unknown>;

  constructor(statusCode: number, message: string, payload?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.payload = payload;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A business-rule rejection that carries the full structured response body
 * (e.g. `{ error, code, detail }`). Preserves pre-M6 responses that returned
 * more than a plain `{ error }`.
 */
export class BusinessRuleError extends AppError {
  constructor(statusCode: number, payload: Record<string, unknown>) {
    super(statusCode, String(payload.error ?? "Request rejected"), payload);
  }
}

/** 400 — malformed/invalid request input. */
export class BadRequestError extends AppError {
  constructor(message = "Bad request") {
    super(400, message);
  }
}

/** 401 — not authenticated. */
export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required.") {
    super(401, message);
  }
}

/** 403 — authenticated but not allowed. */
export class ForbiddenError extends AppError {
  constructor(message = "Access denied.") {
    super(403, message);
  }
}

/** 404 — resource not found. */
export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

/** 409 — conflict (duplicate, immutability guard, illegal state transition). */
export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(409, message);
  }
}

/** 423 — the accounting period is locked (mirrors the pre-M6 period-lock error). */
export class PeriodLockedError extends AppError {
  constructor(message: string) {
    super(423, message);
  }
}
