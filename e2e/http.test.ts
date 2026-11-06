import { describe, expect, inject, it } from "vitest";
import { api, sessionCookie, unsignedIdToken } from "./helpers";

const appOrigin = inject("appOrigin");

describe("health", () => {
  it("answers / and /healthz", async () => {
    const root = await api("/");
    expect(root.status).toBe(200);
    expect(await root.text()).toBe("OK");

    const health = await api("/healthz");
    expect(health.status).toBe(200);
    const body = await health.json();
    expect(body.ready).toBe(true);
    expect(Math.abs(Date.parse(body.time) - Date.now())).toBeLessThan(60_000);
  });
});

describe("response headers", () => {
  it("include the security headers and do not name the framework", async () => {
    const response = await api("/healthz");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(response.headers.has("x-powered-by")).toBe(false);
  });
});

describe("CORS", () => {
  const preflight = (origin: string) =>
    api("/devices", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "GET" },
    });

  it("lets the web app call the API with its cookies", async () => {
    const response = await preflight(appOrigin);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(appOrigin);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it.each(["https://evil.example", "https://app.e2e.test.evil.example", "null"])(
    "does not let %s read responses",
    async origin => {
      const response = await preflight(origin);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);

      const simple = await api("/healthz", { headers: { origin } });
      expect(simple.headers.has("access-control-allow-origin")).toBe(false);
    },
  );
});

describe("routes that need a signed-in user", () => {
  const routes: [string, string][] = [
    ["GET", "/me"],
    ["GET", "/devices"],
    ["GET", "/devices/some-device"],
    ["PUT", "/devices/some-device"],
    ["POST", "/webrtc/session"],
    ["POST", "/webrtc/ice_config"],
    ["POST", "/webrtc/turn_activity"],
  ];

  const call = (method: string, path: string, headers: Record<string, string> = {}) =>
    api(path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: method === "GET" ? undefined : "{}",
    });

  it.each(routes)("%s %s answers 401 without a session", async (method, path) => {
    const response = await call(method, path);
    expect(response.status).toBe(401);
    expect((await response.json()).name).toBe("Unauthorized");
  });

  it.each(routes)(
    "%s %s answers 401 to an ID token Google did not sign",
    async (method, path) => {
      const cookie = sessionCookie({
        id_token: unsignedIdToken({ sub: "e2e-attacker", email: "a@e2e.test" }),
      });
      expect((await call(method, path, { cookie })).status).toBe(401);
    },
  );

  it("ignores a session cookie signed with another secret", async () => {
    const cookie = sessionCookie(
      { id_token: unsignedIdToken({ sub: "e2e-attacker" }) },
      "not-the-secret",
    );
    expect((await api("/devices", { headers: { cookie } })).status).toBe(401);
  });
});

describe("errors", () => {
  it("answer an unknown route with 404", async () => {
    expect((await api("/does-not-exist")).status).toBe(404);
  });

  it("do not include a stack trace", async () => {
    const response = await api("/releases");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      name: "BadRequestError",
      message: "Device ID is required",
    });
  });
});

describe("sign-in and sign-out", () => {
  it("the OIDC callback passes the query on to the cookie-carrying route, on this host", async () => {
    const response = await api("/oidc/callback?code=abc&state=xyz");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`URL='/oidc/callback_o?code=abc&state=xyz'`);
  });

  it("logout clears the session cookie", async () => {
    const response = await api("/logout", {
      method: "POST",
      // As behind the TLS-terminating proxy, which the secure cookie needs
      headers: { "x-forwarded-proto": "https", cookie: sessionCookie({ id_token: "x" }) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "Logged out" });
    const setCookie = response.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/session=;/);
    expect(setCookie).toMatch(/expires=Thu, 01 Jan 1970/i);
  });
});
