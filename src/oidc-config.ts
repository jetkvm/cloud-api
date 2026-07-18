import * as jose from "jose";
import { Issuer } from "openid-client";

const DEFAULT_OIDC_SCOPES = "openid email profile";

let issuerPromise: ReturnType<typeof Issuer.discover> | null = null;
let jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

const getRequiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
};

export const getOidcIssuerUrl = () => getRequiredEnv("OIDC_ISSUER");

export const getOidcClientId = () => getRequiredEnv("OIDC_CLIENT_ID");

export const getOidcClientSecret = () => getRequiredEnv("OIDC_CLIENT_SECRET");

export const getOidcScopes = () =>
  process.env.OIDC_SCOPES || DEFAULT_OIDC_SCOPES;

export const getOidcIssuer = async () => {
  if (!issuerPromise) {
    issuerPromise = Issuer.discover(getOidcIssuerUrl());
  }
  return issuerPromise;
};

export const getOidcExpectedIssuer = async () => {
  const issuer = await getOidcIssuer();
  return issuer.metadata.issuer || getOidcIssuerUrl();
};

export const getOidcClient = async (redirectUri: string) => {
  const issuer = await getOidcIssuer();
  const clientId = getOidcClientId();
  const clientSecret = getOidcClientSecret();

  return new issuer.Client({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: [redirectUri],
    response_types: ["code"],
  });
};

export const getOidcJwks = async () => {
  if (jwks) return jwks;

  const issuer = await getOidcIssuer();
  const jwksUri = issuer.metadata.jwks_uri;
  if (!jwksUri) {
    throw new Error("OIDC issuer does not expose a jwks_uri");
  }

  jwks = jose.createRemoteJWKSet(new URL(jwksUri));
  return jwks;
};
