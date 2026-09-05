import { describe, it, expect, vi } from "vitest";
import { Request, Response } from "express";
import * as jose from "jose";
import {
  authenticated,
  getActiveSession,
  SESSION_ABSOLUTE_MAX_AGE_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from "../src/auth";
import { UnauthorizedError } from "../src/errors";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Builds an ID token like the one openid-client stores in the session after
// sign-in. The signature is irrelevant here: sessions are trusted because the
// cookie is signed with COOKIE_SECRET, not because the token is re-verified.
async function idToken(opts: { issuedAgoMs: number; ttlMs?: number; email?: string }) {
  const now = Date.now();
  const iat = Math.floor((now - opts.issuedAgoMs) / 1000);
  const exp = Math.floor((now - opts.issuedAgoMs + (opts.ttlMs ?? HOUR)) / 1000);
  return new jose.SignJWT({ email: opts.email ?? "user@example.com", sub: "123" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("https://accounts.google.com")
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode("test-key"));
}

function runMiddleware(session: Record<string, unknown> | null) {
  const req = { session } as unknown as Request;
  const res = {} as Response;
  const next = vi.fn();
  return { req, run: () => authenticated(req, res, next), next };
}

describe("getActiveSession", () => {
  it("returns null without a session or token", () => {
    expect(getActiveSession(null)).toBeNull();
    expect(getActiveSession(undefined)).toBeNull();
    expect(getActiveSession({} as any)).toBeNull();
    expect(getActiveSession({ id_token: "not-a-jwt" } as any)).toBeNull();
  });

  it("stays active after the ID token's own expiry has passed", async () => {
    // Google ID tokens live ~1h; that is not the session lifetime.
    const token = await idToken({ issuedAgoMs: 5 * HOUR });
    const active = getActiveSession({
      id_token: token,
      authenticatedAt: Date.now() - 5 * HOUR,
    } as any);
    expect(active?.claims.email).toBe("user@example.com");
  });

  it("expires once the absolute lifetime is exceeded", async () => {
    const token = await idToken({ issuedAgoMs: 1 * HOUR });
    const authenticatedAt = Date.now() - SESSION_ABSOLUTE_MAX_AGE_MS - DAY;
    expect(getActiveSession({ id_token: token, authenticatedAt } as any)).toBeNull();
  });

  it("falls back to the token's iat for sessions created before authenticatedAt", async () => {
    const recent = await idToken({ issuedAgoMs: 2 * DAY });
    expect(getActiveSession({ id_token: recent } as any)).not.toBeNull();

    const ancient = await idToken({ issuedAgoMs: 40 * DAY });
    expect(getActiveSession({ id_token: ancient } as any)).toBeNull();
  });
});

describe("authenticated middleware", () => {
  it("rejects requests without a session", async () => {
    const { run, next } = runMiddleware(null);
    await expect(run()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts a session whose ID token expired hours ago", async () => {
    const token = await idToken({ issuedAgoMs: 6 * HOUR });
    const { run, next } = runMiddleware({
      id_token: token,
      authenticatedAt: Date.now() - 6 * HOUR,
    });
    await run();
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects a session past the absolute lifetime", async () => {
    const token = await idToken({ issuedAgoMs: 0 });
    const { run, next } = runMiddleware({
      id_token: token,
      authenticatedAt: Date.now() - SESSION_ABSOLUTE_MAX_AGE_MS - 1,
    });
    await expect(run()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(next).not.toHaveBeenCalled();
  });

  it("touches lastActiveAt so the cookie's idle timeout rolls, but not on every request", async () => {
    const token = await idToken({ issuedAgoMs: 0 });
    const session: Record<string, unknown> = {
      id_token: token,
      authenticatedAt: Date.now(),
    };

    const first = runMiddleware(session);
    await first.run();
    const touched = session.lastActiveAt as number;
    expect(typeof touched).toBe("number");

    // Within the touch interval the session is left untouched, so
    // cookie-session doesn't re-send the cookie on every request.
    const second = runMiddleware(session);
    await second.run();
    expect(session.lastActiveAt).toBe(touched);

    // Once the interval has elapsed, the next request touches it again.
    const stale = Date.now() - SESSION_TOUCH_INTERVAL_MS - 1;
    session.lastActiveAt = stale;
    const before = Date.now();
    const third = runMiddleware(session);
    await third.run();
    expect(session.lastActiveAt as number).toBeGreaterThanOrEqual(before);
  });
});
