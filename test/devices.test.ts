import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { testPrisma } from "./setup";

// webrtc-signaling pulls in src/index.ts (the listening server). Devices only
// need the connection map, so stub the module with an empty one.
const activeConnections = new Map();
vi.mock("../src/webrtc-signaling", () => ({ activeConnections }));

const { List, Retrieve, Token } = await import("../src/devices");

const GOOGLE_ID = "devices-test-google-id";
const DEVICE_ID = "devices-test-device";
const TEMP_TOKEN = "devices-test-temp-token";

function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

function tokenRequest(body: Record<string, unknown>): Request {
  return { body } as unknown as Request;
}

function sessionRequest(params: Record<string, string> = {}): Request {
  return {
    params,
    session: { id_token: unsignedJwt({ iss: "https://accounts.google.com", sub: GOOGLE_ID }) },
  } as unknown as Request;
}

function mockResponse(): Response & { _json: any } {
  const res = {
    _json: null,
    status: vi.fn(function (this: any) {
      return this;
    }),
    json: vi.fn(function (this: any, data: any) {
      this._json = data;
      return this;
    }),
  };
  return res as unknown as Response & { _json: any };
}

describe("device live state", () => {
  beforeEach(async () => {
    activeConnections.clear();
    const user = await testPrisma.user.upsert({
      where: { googleId: GOOGLE_ID },
      update: {},
      create: { googleId: GOOGLE_ID },
    });
    await testPrisma.device.create({
      data: {
        id: DEVICE_ID,
        userId: user.id,
        tempToken: TEMP_TOKEN,
        tempTokenExpiresAt: new Date(Date.now() + 60_000),
      },
    });
  });

  afterEach(async () => {
    await testPrisma.device.deleteMany({ where: { id: DEVICE_ID } });
    await testPrisma.user.deleteMany({ where: { googleId: GOOGLE_ID } });
  });

  it("issues a secret token and consumes the temp token", async () => {
    const res = mockResponse();
    await Token(tokenRequest({ tempToken: TEMP_TOKEN }), res);

    expect(res._json.secretToken).toMatch(/^[0-9a-f]{40}$/);
    const device = await testPrisma.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    expect(device.tempToken).toBeNull();
  });

  it("reports no version or SKU for an offline device", async () => {
    const res = mockResponse();
    await Retrieve(sessionRequest({ id: DEVICE_ID }), res);

    expect(res._json.device).toMatchObject({
      id: DEVICE_ID,
      online: false,
      version: null,
      sku: null,
    });
  });

  it("treats an online device that sent no SKU as the original hardware", async () => {
    activeConnections.set(DEVICE_ID, { ws: {}, ip: "10.0.0.2", version: "0.5.9", sku: null });

    const res = mockResponse();
    await Retrieve(sessionRequest({ id: DEVICE_ID }), res);

    expect(res._json.device).toMatchObject({ online: true, version: "0.5.9", sku: "jetkvm-v2" });
  });

  it("reports the SKU and version from the live connection", async () => {
    activeConnections.set(DEVICE_ID, {
      ws: {},
      ip: "10.0.0.2",
      version: "1.2.3",
      sku: "jetkvm-mini-ethernet",
    });

    const res = mockResponse();
    await Retrieve(sessionRequest({ id: DEVICE_ID }), res);

    expect(res._json.device).toMatchObject({
      sku: "jetkvm-mini-ethernet",
      online: true,
      version: "1.2.3",
    });
  });

  it("lists devices with the same live state", async () => {
    activeConnections.set(DEVICE_ID, {
      ws: {},
      ip: "10.0.0.2",
      version: "1.2.3",
      sku: "jetkvm-mini-wireless",
    });

    const res = mockResponse();
    await List(sessionRequest(), res);

    expect(res._json.devices).toEqual([
      expect.objectContaining({
        id: DEVICE_ID,
        online: true,
        version: "1.2.3",
        sku: "jetkvm-mini-wireless",
      }),
    ]);
  });
});
