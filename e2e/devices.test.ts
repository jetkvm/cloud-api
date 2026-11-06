import { beforeEach, describe, expect, it } from "vitest";
import {
  api,
  closed,
  createUserWithDevice,
  db,
  openSocket,
  sessionCookie,
  unsignedIdToken,
} from "./helpers";

beforeEach(async () => {
  await db.device.deleteMany({ where: { id: { startsWith: "e2e-dev-" } } });
  await db.user.deleteMany({ where: { googleId: { startsWith: "e2e-dev-" } } });
});

function exchange(tempToken?: string) {
  return api("/devices/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tempToken === undefined ? {} : { tempToken }),
  });
}

async function deviceWithTempToken(id: string, tempToken: string, expiresInMs: number) {
  await db.user.create({
    data: {
      googleId: `e2e-dev-${id}-owner`,
      device: {
        create: { id, tempToken, tempTokenExpiresAt: new Date(Date.now() + expiresInMs) },
      },
    },
  });
}

describe("device registration (POST /devices/token)", () => {
  it("trades a temporary token for a secret token the device can connect with, once", async () => {
    await deviceWithTempToken("e2e-dev-1", "temp-1", 60_000);

    const response = await exchange("temp-1");
    expect(response.status).toBe(200);
    const { secretToken } = await response.json();
    expect(secretToken).toMatch(/^[0-9a-f]{40}$/);

    const device = await db.device.findUniqueOrThrow({ where: { id: "e2e-dev-1" } });
    expect(device).toMatchObject({
      secretToken,
      tempToken: null,
      tempTokenExpiresAt: null,
    });

    // The temporary token is single-use
    expect((await exchange("temp-1")).status).toBe(404);

    const ws = await openSocket("/", {
      authorization: `Bearer ${secretToken}`,
      "x-device-id": "e2e-dev-1",
    });
    ws.close();
    await closed(ws);
  });

  it("refuses an expired temporary token and leaves the device without a secret", async () => {
    await deviceWithTempToken("e2e-dev-2", "temp-2", -1_000);
    expect((await exchange("temp-2")).status).toBe(401);
    expect(
      (await db.device.findUniqueOrThrow({ where: { id: "e2e-dev-2" } })).secretToken,
    ).toBeNull();
  });

  it("answers 404 to an unknown token and 422 to a missing one", async () => {
    expect((await exchange("never-issued")).status).toBe(404);
    expect((await exchange()).status).toBe(422);
  });
});

describe("device removal (DELETE /devices/:id)", () => {
  it("lets the device remove itself with its secret token", async () => {
    await createUserWithDevice("e2e-dev-owner-3", "e2e-dev-3", "secret-3");

    const response = await api("/devices/e2e-dev-3", {
      method: "DELETE",
      headers: { authorization: "Bearer secret-3" },
    });
    expect(response.status).toBe(204);
    expect(await db.device.findUnique({ where: { id: "e2e-dev-3" } })).toBeNull();
  });

  it("answers 404 to a secret token that belongs to no device", async () => {
    await createUserWithDevice("e2e-dev-owner-4", "e2e-dev-4", "secret-4");
    const response = await api("/devices/e2e-dev-4", {
      method: "DELETE",
      headers: { authorization: "Bearer someone-elses-secret" },
    });
    expect(response.status).toBe(404);
    expect(await db.device.findUnique({ where: { id: "e2e-dev-4" } })).not.toBeNull();
  });

  it("answers 401 without credentials and keeps serving", async () => {
    await createUserWithDevice("e2e-dev-owner-5", "e2e-dev-5", "secret-5");

    const response = await api("/devices/e2e-dev-5", {
      method: "DELETE",
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(401);
    expect(await db.device.findUnique({ where: { id: "e2e-dev-5" } })).not.toBeNull();
    expect((await api("/healthz")).status).toBe(200);
  });

  it("answers 401 to a session whose ID token Google did not sign", async () => {
    await createUserWithDevice("e2e-dev-owner-6", "e2e-dev-6", "secret-6");
    const cookie = sessionCookie({
      id_token: unsignedIdToken({ sub: "e2e-dev-owner-6" }),
    });

    const response = await api("/devices/e2e-dev-6", {
      method: "DELETE",
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(401);
    expect(await db.device.findUnique({ where: { id: "e2e-dev-6" } })).not.toBeNull();
  });
});
