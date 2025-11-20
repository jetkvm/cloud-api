import { generators, Issuer } from "openid-client";
import express from "express";
import { prisma } from "./db";
import { BadRequestError } from "./errors";
import * as crypto from "crypto";

const API_HOSTNAME = process.env.API_HOSTNAME;
const APP_HOSTNAME = process.env.APP_HOSTNAME;
const REDIRECT_URI = `${API_HOSTNAME}/oidc/callback`;

/**
 * Validates that a returnTo URL belongs to the application's domain.
 * Only allows URLs with the same host as APP_HOSTNAME.
 *
 * @param returnTo - The URL to validate
 * @param appHostname - The application's hostname from APP_HOSTNAME env var
 * @returns true if valid, false otherwise
 */
function isValidReturnToUrl(returnTo: string, appHostname: string): boolean {
  try {
    const returnToUrl = new URL(returnTo);
    const appUrl = new URL(appHostname);

    // Only allow same host (includes protocol, hostname, and port)
    return returnToUrl.host === appUrl.host;
  } catch {
    // Invalid URL format
    return false;
  }
}

const getGoogleOIDCClient = async () => {
  const googleIssuer = await Issuer.discover("https://accounts.google.com");
  return new googleIssuer.Client({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uris: [REDIRECT_URI],
    response_types: ["code"],
  });
};

export const Google = async (req: express.Request, res: express.Response) => {
  const state = new URLSearchParams();

  // Generate a CSRF token and store it in the session, so the callback
  // can ensure that the request is the same as the one that was initiated.
  state.set("csrf", generators.state());
  req.session!.csrf = state.get("csrf");

  req.session!.deviceId = req.body.deviceId;

  // Validate returnTo URL if provided
  const requestedReturnTo = req.body.returnTo;
  if (requestedReturnTo) {
    if (!isValidReturnToUrl(requestedReturnTo, APP_HOSTNAME)) {
      throw new BadRequestError(
        "Invalid returnTo URL: must be a valid URL within the application domain",
        "invalid_return_to_url"
      );
    }
    req.session!.returnTo = requestedReturnTo;
  } else {
    req.session!.returnTo = null;
  }

  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);
  req.session!.code_verifier = code_verifier;

  const client = await getGoogleOIDCClient();
  const authorizationUrl = client.authorizationUrl({
    scope: "openid email profile",
    state: state.toString(),
    // This ensures that to even issue the token, the client must have the code_verifier,
    // which is stored in the session cookie.
    code_challenge,
    code_challenge_method: "S256",
  });
  return res.redirect(authorizationUrl);
};

export const Callback = async (req: express.Request, res: express.Response) => {
  const client = await getGoogleOIDCClient();

  // Retrieve recognized callback parameters from the request, e.g. code and state
  const params = client.callbackParams(req);
  if (!params)
    throw new BadRequestError("Missing callback parameters", "missing_callback_params");

  const sessionCsrf = req.session?.csrf;
  if (!sessionCsrf) {
    throw new BadRequestError("Missing CSRF in session", "missing_csrf");
  }

  const thisRequestCsrf = new URLSearchParams(params.state).get("csrf");
  if (thisRequestCsrf !== sessionCsrf) {
    throw new BadRequestError("Invalid CSRF", "invalid_csrf");
  }

  const deviceId = req.session?.deviceId as string | undefined;
  const returnTo = (req.session?.returnTo ?? `${APP_HOSTNAME}/devices`) as string;

  req.session!.csrf = null;
  req.session!.returnTo = null;
  req.session!.deviceId = null;

  // Exchange code for access token and ID token
  const tokenSet = await client.callback(REDIRECT_URI, params, {
    state: req.query.state?.toString(),
    code_verifier: req.session?.code_verifier,
  });

  const userInfo = await client.userinfo(tokenSet);

  // TokenClaims is an object that contains the sub, email, name and other claims
  const tokenClaims = tokenSet.claims();
  if (!tokenClaims) {
    throw new BadRequestError("Missing claims in token", "missing_claims");
  }

  if (!tokenSet.id_token) {
    throw new BadRequestError("Missing ID Token", "missing_id_token");
  }

  req.session!.id_token = tokenSet.id_token;

  await prisma.user.upsert({
    where: { googleId: tokenClaims.sub },
    update: {
      googleId: tokenClaims.sub,
      email: userInfo.email,
      picture: userInfo.picture,
    },
    create: {
      googleId: tokenClaims.sub,
      email: userInfo.email,
      picture: userInfo.picture,
    },
  });

  // This means the user is trying to adopt a device by first logging/signin up/in
  if (deviceId) {
    const deviceAdopted = await prisma.device.findUnique({
      where: { id: deviceId },
      select: { user: { select: { googleId: true } } },
    });


    const isAdoptedByCurrentUser = deviceAdopted?.user.googleId === tokenClaims.sub;
    const isAdoptedByOther = deviceAdopted && !isAdoptedByCurrentUser;
    if (isAdoptedByOther) {
      // Device is already adopted by another user. This can happen if:
      // 1. The device was resold without being de-registered by the previous owner.
      // 2. Someone is trying to adopt a device they don't own.
      //
      // Security note:
      // The previous owner can't connect to the device anymore because:
      // - The device would have done a hardware reset, erasing its deviceToken.
      // - Without a valid deviceToken, the device can't connect to the cloud API.
      //
      // This check prevents unauthorized adoption and ensures proper ownership transfer.
      // The cost of this check is therefore, that the previous owner has to re-register the device.
      return res.redirect(`${APP_HOSTNAME}/already-adopted`);
    }

    // Temp Token expires in 5 minutes
    const tempToken = crypto.randomBytes(20).toString("hex");
    const tempTokenExpiresAt = new Date(new Date().getTime() + 5 * 60000);

    await prisma.user.update({
      where: { googleId: tokenClaims.sub },
      data: {
        device: {
          upsert: {
            create: { id: deviceId, tempToken, tempTokenExpiresAt },
            where: { id: deviceId },
            update: { tempToken, tempTokenExpiresAt },
          },
        },
      },
    });

    console.log("Adopted device", deviceId, "for user", tokenClaims.sub);

    // Validate returnTo before redirecting (defense in depth)
    if (!isValidReturnToUrl(returnTo, APP_HOSTNAME)) {
      console.warn("Invalid returnTo URL detected at redirect point:", returnTo);
      // Fall back to safe default
      const safeUrl = new URL(`${APP_HOSTNAME}/devices`);
      safeUrl.searchParams.append("tempToken", tempToken);
      safeUrl.searchParams.append("deviceId", deviceId);
      safeUrl.searchParams.append("oidcGoogle", tokenSet.id_token.toString());
      safeUrl.searchParams.append("clientId", process.env.GOOGLE_CLIENT_ID);
      return res.redirect(safeUrl.toString());
    }

    const url = new URL(returnTo);
    url.searchParams.append("tempToken", tempToken);
    url.searchParams.append("deviceId", deviceId);
    url.searchParams.append("oidcGoogle", tokenSet.id_token.toString());
    url.searchParams.append("clientId", process.env.GOOGLE_CLIENT_ID);
    return res.redirect(url.toString());
  }
  // Validate returnTo before redirecting (defense in depth)
  if (!isValidReturnToUrl(returnTo, APP_HOSTNAME)) {
    console.warn("Invalid returnTo URL detected at redirect point:", returnTo);
    // Fall back to safe default
    return res.redirect(`${APP_HOSTNAME}/devices`);
  }
  return res.redirect(returnTo);
};
