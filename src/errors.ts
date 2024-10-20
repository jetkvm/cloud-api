export class HttpError extends Error {
  status: number;
  code?: string;

  constructor(status: number, m?: string) {
    super(m);
    this.status = status;
  }
}

export class BadRequestError extends HttpError {
  constructor(message?: string, code?: string) {
    super(400, message);
    this.name = "BadRequestError";
    this.code = code;
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message?: string, code?: string) {
    super(401, message);
    this.name = "Unauthorized";
    this.code = code;
  }
}

export class ForbiddenError extends HttpError {
  constructor(message?: string, code?: string) {
    super(403, message);
    this.name = "Forbidden";
  }
}

export class NotFoundError extends HttpError {
  constructor(message?: string, code?: string) {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class UnprocessableEntityError extends HttpError {
  constructor(message?: string, code?: string) {
    super(422, message);
    this.code = code;
    this.name = "UnprocessableEntityError";
  }
}

export class InternalServerError extends HttpError {
  constructor(message?: string, code?: string) {
    super(500, message);
    this.code = code;
    this.name = "InternalServerError";
  }
}
