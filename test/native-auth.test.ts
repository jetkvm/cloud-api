import { describe, it, expect, beforeAll, vi } from "vitest";
import { Request, Response } from "express";

type NativeAuth = typeof import("../src/native-auth");

// The scheme allowlist is read once at import, like ALLOWED_IDENTITIES.
async function loadWithSchemes(schemes: string | undefined): Promise<NativeAuth> {
  vi.resetModules();
  if (schemes === undefined) delete process.env.NATIVE_APP_SCHEMES;
  else process.env.NATIVE_APP_SCHEMES = schemes;
  return import("../src/native-auth");
}

function mockResponse() {
  return { json: vi.fn(), redirect: vi.fn() } as unknown as Response & {
    json: ReturnType<typeof vi.fn>;
  };
}

describe("isNativeReturnTo", () => {
  let nativeAuth: NativeAuth;
  beforeAll(async () => {
    nativeAuth = await loadWithSchemes("jetpilot, MyApp:");
  });

  it("accepts URLs on a registered scheme, case-insensitively", () => {
    expect(nativeAuth.isNativeReturnTo("jetpilot://auth")).toBe(true);
    expect(nativeAuth.isNativeReturnTo("JetPilot://auth/done?x=1")).toBe(true);
    expect(nativeAuth.isNativeReturnTo("myapp://signed-in")).toBe(true);
  });

  it("rejects web URLs, unregistered schemes, and garbage", () => {
    expect(nativeAuth.isNativeReturnTo("https://app.jetkvm.com/devices")).toBe(false);
    expect(nativeAuth.isNativeReturnTo("http://jetpilot/auth")).toBe(false);
    expect(nativeAuth.isNativeReturnTo("otherapp://auth")).toBe(false);
    expect(nativeAuth.isNativeReturnTo("javascript:alert(1)")).toBe(false);
    expect(nativeAuth.isNativeReturnTo("not a url")).toBe(false);
    expect(nativeAuth.isNativeReturnTo(undefined)).toBe(false);
    expect(nativeAuth.isNativeReturnTo(null)).toBe(false);
  });

  it("is disabled when NATIVE_APP_SCHEMES is unset", async () => {
    const disabled = await loadWithSchemes(undefined);
    expect(disabled.isNativeReturnTo("jetpilot://auth")).toBe(false);
  });
});

describe("native auth codes", () => {
  let nativeAuth: NativeAuth;
  beforeAll(async () => {
    nativeAuth = await loadWithSchemes("jetpilot");
  });

  it("are single-use", () => {
    const code = nativeAuth.issueNativeAuthCode({ id_token: "token-1" });
    expect(code.length).toBeGreaterThanOrEqual(43);
    expect(nativeAuth.redeemNativeAuthCode(code)).toEqual({ id_token: "token-1" });
    expect(nativeAuth.redeemNativeAuthCode(code)).toBeUndefined();
    expect(nativeAuth.redeemNativeAuthCode("nope")).toBeUndefined();
  });

  it("are appended to the app's returnTo as `code`", () => {
    const url = new URL(
      nativeAuth.nativeRedirectUrl("jetpilot://auth?from=cloud", "abc"),
    );
    expect(url.protocol).toBe("jetpilot:");
    expect(url.searchParams.get("from")).toBe("cloud");
    expect(url.searchParams.get("code")).toBe("abc");
  });
});

describe("POST /auth/exchange", () => {
  let nativeAuth: NativeAuth;
  beforeAll(async () => {
    nativeAuth = await loadWithSchemes("jetpilot");
  });

  it("requires a code", async () => {
    const req = { body: {}, session: null } as unknown as Request;
    // Compared by status: vi.resetModules() gives the error classes a new identity.
    await expect(nativeAuth.Exchange(req, mockResponse())).rejects.toMatchObject({
      status: 422,
    });
  });

  it("rejects unknown or already-used codes", async () => {
    const code = nativeAuth.issueNativeAuthCode({ id_token: "token-2" });
    nativeAuth.redeemNativeAuthCode(code);
    const req = { body: { code }, session: null } as unknown as Request;
    await expect(nativeAuth.Exchange(req, mockResponse())).rejects.toMatchObject({
      status: 401,
      code: "invalid_auth_code",
    });
  });

  it("establishes a session for a valid code", async () => {
    const code = nativeAuth.issueNativeAuthCode({ id_token: "token-3" });
    const req = { body: { code }, session: null } as unknown as Request;
    const res = mockResponse();
    await nativeAuth.Exchange(req, res);
    expect(req.session).toEqual({ id_token: "token-3" });
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});
