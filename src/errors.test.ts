import { describe, it, expect } from 'vitest';
import {
  HttpError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
  InternalServerError,
} from './errors';

describe('HttpError', () => {
  it('should create error with status code and message', () => {
    const error = new HttpError(500, 'Server error');

    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(500);
    expect(error.message).toBe('Server error');
  });

  it('should create error without message', () => {
    const error = new HttpError(404);

    expect(error.status).toBe(404);
    expect(error.message).toBe('');
  });
});

describe('BadRequestError', () => {
  it('should create 400 error with message and code', () => {
    const error = new BadRequestError('Invalid input', 'INVALID_INPUT');

    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.name).toBe('BadRequestError');
    expect(error.message).toBe('Invalid input');
    expect(error.code).toBe('INVALID_INPUT');
  });

  it('should create 400 error without code', () => {
    const error = new BadRequestError('Bad request');

    expect(error.status).toBe(400);
    expect(error.code).toBeUndefined();
  });
});

describe('UnauthorizedError', () => {
  it('should create 401 error', () => {
    const error = new UnauthorizedError('Not authenticated', 'NO_TOKEN');

    expect(error.status).toBe(401);
    expect(error.name).toBe('Unauthorized');
    expect(error.message).toBe('Not authenticated');
    expect(error.code).toBe('NO_TOKEN');
  });
});

describe('ForbiddenError', () => {
  it('should create 403 error', () => {
    const error = new ForbiddenError('Access denied');

    expect(error.status).toBe(403);
    expect(error.name).toBe('Forbidden');
    expect(error.message).toBe('Access denied');
  });
});

describe('NotFoundError', () => {
  it('should create 404 error', () => {
    const error = new NotFoundError('Resource not found');

    expect(error.status).toBe(404);
    expect(error.name).toBe('NotFoundError');
    expect(error.message).toBe('Resource not found');
  });
});

describe('UnprocessableEntityError', () => {
  it('should create 422 error', () => {
    const error = new UnprocessableEntityError('Validation failed', 'VALIDATION_ERROR');

    expect(error.status).toBe(422);
    expect(error.name).toBe('UnprocessableEntityError');
    expect(error.code).toBe('VALIDATION_ERROR');
  });
});

describe('InternalServerError', () => {
  it('should create 500 error', () => {
    const error = new InternalServerError('Server malfunction', 'DATABASE_ERROR');

    expect(error.status).toBe(500);
    expect(error.name).toBe('InternalServerError');
    expect(error.message).toBe('Server malfunction');
    expect(error.code).toBe('DATABASE_ERROR');
  });
});
