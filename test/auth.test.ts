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

  it("calls next for the configured token", () => {
    const next = vi.fn();
    guard(request("Bearer release-sync-secret"), res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ["no header", undefined],
    ["wrong token", "Bearer nope"],
    ["missing scheme", "release-sync-secret"],
    ["prefix of the token", "Bearer release-sync"],
  ])("rejects %s without calling next", (_label, authorization) => {
    const next = vi.fn();
    expect(() => guard(request(authorization), res, next)).toThrow(UnauthorizedError);
    expect(next).not.toHaveBeenCalled();
  });
});
