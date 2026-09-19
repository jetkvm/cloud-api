import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { bearerToken } from "../src/auth";
import { UnauthorizedError } from "../src/errors";

describe("bearerToken", () => {
  const guard = bearerToken("release-sync-secret");
  const res = {} as Response;

  function request(authorization?: string): Request {
    return { headers: { authorization } } as unknown as Request;
  }

  it.each(["Bearer release-sync-secret", "bearer release-sync-secret", "BEARER  release-sync-secret"])(
    "calls next for %j",
    authorization => {
      const next = vi.fn();
      guard(request(authorization), res, next);
      expect(next).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["no header", undefined],
    ["wrong token", "Bearer nope"],
    ["missing scheme", "release-sync-secret"],
    ["prefix of the token", "Bearer release-sync"],
    ["token in a different case", "Bearer RELEASE-SYNC-SECRET"],
  ])("rejects %s without calling next", (_label, authorization) => {
    const next = vi.fn();
    expect(() => guard(request(authorization), res, next)).toThrow(UnauthorizedError);
    expect(next).not.toHaveBeenCalled();
  });
});
