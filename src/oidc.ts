import * as client from "openid-client";
import express from "express";
import { prisma } from "./db";
import { UnauthorizedError } from "./errors";
import * as crypto from "crypto";

const API_HOSTNAME = process.env.API_HOSTNAME;
const APP_HOSTNAME = process.env.APP_HOSTNAME;
const REDIRECT_URI = `${API_HOSTNAME}/oidc/callback`;

const getConfig = async () => {
  let server: URL = new URL("https://accounts.google.com") // Authorization server's Issuer Identifier URL
  let clientId: string = process.env.GOOGLE_CLIENT_ID
  let clientSecret: string = process.env.GOOGLE_CLIENT_SECRET
  let config = await client.discovery(server, clientId, clientSecret)
  return config
};

export const Google = async (req: express.Request, res: express.Response) => {
  let code_challenge_method = 'S256'
  let code_verifier = client.randomPKCECodeVerifier()
  let code_challenge = await client.calculatePKCECodeChallenge(code_verifier)
  let nonce!: string

  let parameters: Record<string, string> = {
    REDIRECT_URI,
    scope: 'openid email profile',
    code_challenge,
    code_challenge_method,
  }

  let config = await getConfig()
  
  if (!config.serverMetadata().supportsPKCE()) {
    nonce = client.randomNonce()
    parameters.nonce = nonce
  }

  let redirectTo = client.buildAuthorizationUrl(config, parameters)

  req.session!.code_verifier  = code_verifier;
  req.session!.nonce = nonce;
  req.session!.deviceId = req.body.deviceId;
  req.session!.returnTo = req.body.returnTo;

  return res.redirect(redirectTo.toString());
};

export const Callback = async (req: express.Request, res: express.Response) => {
  const session = req.session!;
  let code_verifier = session.code_verifier;
  let nonce = session.nonce;
  let deviceId = session.deviceId as string | undefined;
  let returnTo = (session.returnTo ?? `${APP_HOSTNAME}/devices`) as string;
  let currentUrl: URL = new URL(req.url, `${API_HOSTNAME}`);

  let config = await getConfig()
  let tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: code_verifier,
    expectedNonce: nonce,
    idTokenExpected: true,
  })
  
  let { access_token, id_token } = tokens
  let claims = tokens.claims()!
  let subject = claims.sub;

  session.id_token = id_token;
  session.code_verifier = null;
  session.nonce = null;
  session.returnTo = null;
  session.deviceId = null;

  if (!id_token) throw new UnauthorizedError();

  let userInfo = await client.fetchUserInfo(config, access_token, subject)
  console.log("User", userInfo);

  await prisma.user.upsert({
    where: { googleId: subject },
    update: {
      googleId: subject,
      email: userInfo.email,
      picture: userInfo.picture,
    },
    create: {
      googleId: subject,
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

    const isAdoptedByCurrentUser = deviceAdopted?.user.googleId === subject;
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
      where: { googleId: subject },
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

    console.log("Adopted device", deviceId, "for user", subject);

    const url = new URL(returnTo);
    url.searchParams.append("tempToken", tempToken);
    url.searchParams.append("deviceId", deviceId);
    url.searchParams.append("oidcGoogle", id_token!.toString());
    url.searchParams.append("clientId", process.env.GOOGLE_CLIENT_ID);
    return res.redirect(url.toString());
  }
  return res.redirect(returnTo.toString());
};
