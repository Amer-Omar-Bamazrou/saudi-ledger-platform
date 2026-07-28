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

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
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
