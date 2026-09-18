import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { testPrisma } from "./setup";

// The signaling module imports the cookie-session middleware from src/index.ts,
// which starts the listening server. Replace it with one that reads the session
// from a test header, so client upgrades can carry a session without cookies.
vi.mock("../src/index", () => ({
  cookieSessionMiddleware: (req: any, _res: any, next: () => void) => {
    const raw = req.headers["x-test-session"];
    req.session = raw ? JSON.parse(raw) : {};
    next();
  },
}));

const { activeConnections, registerWebSocketRouter } = await import(
  "../src/webrtc-signaling"
);

const GOOGLE_ID = "signaling-test-google-id";
const DEVICE_ID = "signaling-test-device";
const SECRET_TOKEN = "signaling-test-secret-token";

let server: http.Server;
let port: number;

function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

function sessionHeader(sub: string): Record<string, string> {
  return {
    "x-test-session": JSON.stringify({
      id_token: unsignedJwt({ iss: "https://accounts.google.com", sub }),
    }),
  };
}

interface UpgradeResult {
  status: number;
  /** Present only when the server completed the upgrade (101). */
  socket?: Socket;
}

/**
 * Sends a WebSocket upgrade request and resolves with the status the server
 * answered with. Rejects if the server closes the socket without a response,
 * which is what the handlers did before they wrote a status line.
 */
function upgrade(path: string, headers: Record<string, string> = {}): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => resolve({ status: res.statusCode!, socket }));
    req.on("response", res => {
      res.resume();
      resolve({ status: res.statusCode! });
    });
    req.on("error", reject);
    req.end();
  });
}

const deviceHeaders = (token: string, id = DEVICE_ID) => ({
  Authorization: `Bearer ${token}`,
  "X-Device-ID": id,
  "X-App-Version": "0.5.9",
  "X-Device-SKU": "jetkvm-v2",
});

beforeAll(async () => {
  server = http.createServer((_req, res) => res.writeHead(200).end());
  registerWebSocketRouter(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const conn of activeConnections.values()) conn.ws.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe("upgrade rejections", () => {
  beforeEach(async () => {
    activeConnections.clear();
    const user = await testPrisma.user.upsert({
      where: { googleId: GOOGLE_ID },
      update: {},
      create: { googleId: GOOGLE_ID },
    });
    await testPrisma.device.create({
      data: { id: DEVICE_ID, userId: user.id, secretToken: SECRET_TOKEN },
    });
  });

  afterEach(async () => {
    await testPrisma.device.deleteMany({ where: { id: DEVICE_ID } });
    await testPrisma.user.deleteMany({ where: { googleId: GOOGLE_ID } });
  });

  it("answers 404 for an unknown path", async () => {
    expect((await upgrade("/nope")).status).toBe(404);
  });

  it("answers 401 for a device upgrade without a token", async () => {
    expect((await upgrade("/", { "X-Device-ID": DEVICE_ID })).status).toBe(401);
  });

  it("answers 401 for a device upgrade with a revoked token", async () => {
    expect((await upgrade("/", deviceHeaders("not-the-token"))).status).toBe(401);
    expect(activeConnections.has(DEVICE_ID)).toBe(false);
  });

  it("answers 401 when the device id does not match the token", async () => {
    expect((await upgrade("/", deviceHeaders(SECRET_TOKEN, "other-device"))).status).toBe(401);
  });

  it("completes the upgrade for a valid device token", async () => {
    const result = await upgrade("/", deviceHeaders(SECRET_TOKEN));
    expect(result.status).toBe(101);
    expect(activeConnections.get(DEVICE_ID)).toMatchObject({
      version: "0.5.9",
      sku: "jetkvm-v2",
    });

    result.socket!.destroy();
    await vi.waitFor(() => expect(activeConnections.has(DEVICE_ID)).toBe(false));
  });

  it("answers 401 for a client upgrade without a session", async () => {
    expect((await upgrade(`/webrtc/signaling/client?id=${DEVICE_ID}`)).status).toBe(401);
  });

  it("answers 404 for a client upgrade to a device the user does not own", async () => {
    const result = await upgrade(
      `/webrtc/signaling/client?id=${DEVICE_ID}`,
      sessionHeader("someone-else"),
    );
    expect(result.status).toBe(404);
  });

  it("answers 404 for a client upgrade to a device that is offline", async () => {
    const result = await upgrade(
      `/webrtc/signaling/client?id=${DEVICE_ID}`,
      sessionHeader(GOOGLE_ID),
    );
    expect(result.status).toBe(404);
  });
});
