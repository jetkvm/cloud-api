import { type NextFunction, type Request, type Response } from "express";
import * as jose from "jose";
import { BadRequestError, UnauthorizedError } from "./errors";

const JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs")
const JWKS = jose.createRemoteJWKSet(JWKS_URL);
const verificationOptions = {
  //algorithms: ['RS256'],
  issuer: "https://accounts.google.com",
  audience: process.env.GOOGLE_CLIENT_ID,
};

export const verifyToken = async (idToken: string) => {
  try {
    const { payload } = await jose.jwtVerify(idToken, JWKS, verificationOptions);
    console.log('JWT Payload:', payload);
    return payload;
  } catch (error: any) {
    console.error('JWT Verification Failed:', error.message);
    return null;
  }
};

export const authenticated = async (req: Request, res: Response, next: NextFunction) => {
  const session = req.session;
  if (!session) throw new UnauthorizedError("No session found");

  const idToken = session.id_token;
  if (!idToken) throw new UnauthorizedError("No ID token found in session");

  const payload = await verifyToken(idToken);
  if (!payload) throw new UnauthorizedError("Invalid ID token");

  const { sub, iss, exp } = payload;
  if (!sub) throw new UnauthorizedError("Missing sub (subject) in token");
  if (!iss) throw new UnauthorizedError("Missing iss (issuer) in token");
  if (!exp) throw new UnauthorizedError("Missing exp (expiration) in token");

  if (new Date(payload.exp! * 1000) < new Date()) {
    throw new UnauthorizedError("ID token has expired");
  }

  const isGoogle = iss === "https://accounts.google.com";
  if (!isGoogle) throw new BadRequestError("Token is not from Google");

  req.subject = sub;
  req.issuer = iss;

  next();
};