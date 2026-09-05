import express from "express";
import * as crypto from "crypto";
import { LRUCache } from "lru-cache";
import { UnauthorizedError, UnprocessableEntityError } from "./errors";

/**
 * Native-app sign-in handoff.
 *
 * The normal flow leaves the signed-in session as a cookie in whichever
 * browser ran the OIDC dance. A native app can't read cookies out of the
 * system browser, so today it has to embed a web view and scrape the cookie —
 * which also rules out passkeys (WebKit doesn't expose WebAuthn to embedded
 * views for third-party origins) and is the kind of embedded OAuth Google
 * discourages.
 *
 * With this handoff a native app opens the regular login page in the system
 * browser with a `returnTo` on one of its registered URL schemes
 * (NATIVE_APP_SCHEMES). After sign-in, /oidc/callback redirects there with a
 * short-lived, single-use `code`, and the app exchanges it at
 * POST /auth/exchange for an ordinary session cookie.
 */

const NATIVE_APP_SCHEMES = new Set(
  (process.env.NATIVE_APP_SCHEMES ?? "")
    .split(",")
    .map(scheme => scheme.trim().toLowerCase().replace(/:$/, ""))
    .filter(Boolean),
);

export const NATIVE_AUTH_CODE_TTL_MS = 5 * 60 * 1000;

export interface PendingNativeSession {
  id_token: string;
}

// In-memory like `activeConnections`: codes are only meaningful for the
// instance that issued them, and they live for five minutes at most.
const pendingSessions = new LRUCache<string, PendingNativeSession>({
  max: 10_000,
  ttl: NATIVE_AUTH_CODE_TTL_MS,
});

/** True when `returnTo` is a URL on one of the registered native-app schemes. */
export function isNativeReturnTo(returnTo: unknown): returnTo is string {
  if (typeof returnTo !== "string" || NATIVE_APP_SCHEMES.size === 0) return false;
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return false;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === "http" || scheme === "https") return false;
  return NATIVE_APP_SCHEMES.has(scheme);
}

export function issueNativeAuthCode(session: PendingNativeSession): string {
  const code = crypto.randomBytes(32).toString("base64url");
  pendingSessions.set(code, session);
  return code;
}

/** Returns the session for a code and invalidates the code. */
export function redeemNativeAuthCode(code: string): PendingNativeSession | undefined {
  const session = pendingSessions.get(code);
  if (session) pendingSessions.delete(code);
  return session;
}

export function nativeRedirectUrl(returnTo: string, code: string): string {
  const url = new URL(returnTo);
  url.searchParams.set("code", code);
  return url.toString();
}

/** POST /auth/exchange { code } → session cookie for the native app. */
export const Exchange = async (req: express.Request, res: express.Response) => {
  const { code } = (req.body ?? {}) as { code?: unknown };
  if (typeof code !== "string" || !code) {
    throw new UnprocessableEntityError("Missing code in body");
  }

  const pending = redeemNativeAuthCode(code);
  if (!pending)
    throw new UnauthorizedError("Invalid or expired code", "invalid_auth_code");

  req.session = { id_token: pending.id_token };
  return res.json({ ok: true });
};
