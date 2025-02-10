import { type NextFunction, type Request, type Response } from "express";
import * as jose from "jose";
import { UnauthorizedError } from "./errors";

export const verifyToken = async (idToken: string) => {
  const JWKS = jose.createRemoteJWKSet(
    new URL("https://www.googleapis.com/oauth2/v3/certs"),
  );

  try {
    const { payload } = await jose.jwtVerify(idToken, JWKS, {
      issuer: "https://accounts.google.com",
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    return payload;
  } catch (e) {
    console.error(e);
    return null;
  }
};

export const authenticated = async (req: Request, res: Response, next: NextFunction) => {
  const idToken = req.session?.id_token;
  if (!idToken) throw new UnauthorizedError();

  const payload = await verifyToken(idToken);
  if (!payload) throw new UnauthorizedError();
  if (!payload.exp) throw new UnauthorizedError();

  if (new Date(payload.exp * 1000) < new Date()) {
    throw new UnauthorizedError();
  }

  next();
};
