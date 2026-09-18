import { type NextFunction, type Request, type Response } from "express";
import * as jose from "jose";
import { UnauthorizedError } from "./errors";

const ALLOWED_IDENTITIES = process.env.ALLOWED_IDENTITIES?.split(",")
  .map(identity => identity.trim().toLowerCase())
  .filter(Boolean);

const getAllowedIdentities = () => {
  if (!ALLOWED_IDENTITIES) return null;
  return ALLOWED_IDENTITIES.length > 0 ? new Set(ALLOWED_IDENTITIES) : null;
};

export const isIdentityAllowed = (identity?: string | null) => {
  const allowedIdentities = getAllowedIdentities();
  const identityNormalized = identity?.trim().toLowerCase();
  if (!allowedIdentities) return true;
  if (!identityNormalized) return false;
  return allowedIdentities.has(identityNormalized);
};

/**
 * Hard cap on how long a session may live after sign-in, regardless of
 * activity. The idle timeout is the cookie's `maxAge` (see index.ts), which
 * rolls while the session is in use.
 */
export const SESSION_ABSOLUTE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * cookie-session only re-sends the cookie when the session object changes, so
 * to roll the idle timeout we touch `lastActiveAt` — but at most this often, to
 * avoid a Set-Cookie on every request.
 */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface ActiveSession {
  /** Claims of the ID token verified by openid-client at sign-in. */
  claims: jose.JWTPayload & { email?: string };
}

/**
 * Returns the signed-in identity for a session, or null when the session is
 * missing, malformed, or past its absolute lifetime.
 *
 * The ID token was verified (signature, issuer, audience) by openid-client in
 * the OIDC callback, and the session cookie itself is signed with
 * COOKIE_SECRET, so the token is not re-verified here. In particular its `exp`
 * is NOT treated as the session expiry: Google issues ID tokens for about an
 * hour, and using that as the session lifetime signed everyone out hourly.
 */
export function getActiveSession(
  session: CookieSessionInterfaces.CookieSessionObject | null | undefined,
): ActiveSession | null {
  const idToken = session?.id_token;
  if (typeof idToken !== "string" || !idToken) return null;

  let claims: jose.JWTPayload;
  try {
    claims = jose.decodeJwt(idToken);
  } catch {
    return null;
  }

  // Sessions created before `authenticatedAt` existed fall back to the
  // token's issue time, which is when the user actually signed in.
  const authenticatedAt: unknown =
    session?.authenticatedAt ?? (claims.iat && claims.iat * 1000);
  if (typeof authenticatedAt !== "number") return null;
  if (Date.now() - authenticatedAt > SESSION_ABSOLUTE_MAX_AGE_MS) return null;

  return { claims };
}

export const authenticated = async (req: Request, res: Response, next: NextFunction) => {
  const active = getActiveSession(req.session);
  if (!active) throw new UnauthorizedError();

  if (!isIdentityAllowed(active.claims.email)) {
    throw new UnauthorizedError("Account is not in the allowlist", "account_not_allowed");
  }

  // Roll the idle timeout while the session is in use.
  const lastActiveAt = req.session!.lastActiveAt;
  if (
    typeof lastActiveAt !== "number" ||
    Date.now() - lastActiveAt > SESSION_TOUCH_INTERVAL_MS
  ) {
    req.session!.lastActiveAt = Date.now();
  }

  next();
};
