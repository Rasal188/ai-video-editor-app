const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(id) {
  return typeof id === "string" && UUID_REGEX.test(id);
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class BadRequestError extends ApiError {
  constructor(message = "Invalid request payload.", code = "BAD_REQUEST") {
    super(400, code, message);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "Authentication required.", code = "UNAUTHORIZED") {
    super(401, code, message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "You do not have permission to access this resource.", code = "FORBIDDEN") {
    super(403, code, message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends ApiError {
  constructor(message = "Resource not found.", code = "NOT_FOUND") {
    super(404, code, message);
    this.name = "NotFoundError";
  }
}
