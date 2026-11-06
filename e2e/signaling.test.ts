import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { connect } from "node:net";
import type WebSocket from "ws";
import {
  api,
  closed,
  createUserWithDevice,
  db,
  messages,
  openSocket,
  sessionCookie,
  unsignedIdToken,
} from "./helpers";

const OWNER = "e2e-sig-owner";
const OTHER_USER = "e2e-sig-other";
const DEVICE = "e2e-sig-device";
const SECRET = "e2e-sig-secret";
const DEVICE_IP = "203.0.113.7";

const sockets: WebSocket[] = [];
async function track(socket: Promise<WebSocket>) {
  const ws = await socket;
  sockets.push(ws);
  return ws;
}

function connectDevice(headers: Record<string, string> = {}) {
  return track(
    openSocket("/", {
      authorization: `Bearer ${SECRET}`,
      "x-device-id": DEVICE,
      "x-app-version": "0.5.0",
      "x-device-sku": "jetkvm-v2-sdmmc",
      "x-real-ip": DEVICE_IP,
      ...headers,
    }),
  );
}

const idTokenFor = (sub: string) => unsignedIdToken({ sub });

function connectClient(sub = OWNER, deviceId = DEVICE) {
  return track(
    openSocket(`/webrtc/signaling/client?id=${deviceId}`, {
      cookie: sessionCookie({ id_token: idTokenFor(sub) }),
    }),
  );
}

beforeEach(async () => {
  await db.device.deleteMany({ where: { id: DEVICE } });
  await db.user.deleteMany({ where: { googleId: { in: [OWNER, OTHER_USER] } } });
  await createUserWithDevice(OWNER, DEVICE, SECRET);
  await db.user.create({ data: { googleId: OTHER_USER } });
});

afterEach(async () => {
  await Promise.all(
    sockets.splice(0).map(ws => {
      ws.close();
      return closed(ws).catch(() => undefined);
    }),
  );
});

describe("device connection", () => {
  it.each([
    ["no token", { authorization: "" }],
    ["a wrong token", { authorization: "Bearer wrong" }],
    ["another device's ID", { "x-device-id": "e2e-sig-someone-else" }],
    ["no device ID", { "x-device-id": "" }],
  ])("is refused with %s", async (_name, headers) => {
    await expect(connectDevice(headers)).rejects.toThrow(/rejected/);
  });

  it("records when the device was last seen after it disconnects", async () => {
    const device = await connectDevice();
    device.close();
    await closed(device);

    await expect
      .poll(
        async () =>
          (await db.device.findUniqueOrThrow({ where: { id: DEVICE } })).lastSeen,
      )
      .not.toBeNull();
  });

  it("replaces the earlier connection when the same device connects again", async () => {
    const first = await connectDevice();
    const firstClosed = closed(first);
    await connectDevice({ "x-app-version": "0.5.1" });
    await firstClosed;

    const client = messages(await connectClient());
    expect(await client.next()).toEqual({
      type: "device-metadata",
      data: { deviceVersion: "0.5.1", deviceSku: "jetkvm-v2-sdmmc" },
    });
  });
});

describe("client connection", () => {
  it("is refused without a session", async () => {
    await expect(
      track(openSocket(`/webrtc/signaling/client?id=${DEVICE}`)),
    ).rejects.toThrow(/rejected/);
  });

  it("is refused with a session cookie signed with another secret", async () => {
    await connectDevice();
    const cookie = sessionCookie({ id_token: idTokenFor(OWNER) }, "not-the-secret");
    await expect(
      track(openSocket(`/webrtc/signaling/client?id=${DEVICE}`, { cookie })),
    ).rejects.toThrow(/rejected/);
  });

  it("is refused for a device that belongs to another user", async () => {
    await connectDevice();
    await expect(connectClient(OTHER_USER)).rejects.toThrow(/rejected/);
  });

  it("answers 404 while the device is offline", async () => {
    await expect(connectClient()).rejects.toThrow("rejected: 404");
  });

  it("survives an upgrade request whose target is not a valid URL", async () => {
    const { hostname, port } = new URL(inject("apiUrl"));
    await new Promise<void>(resolve => {
      const socket = connect(Number(port), hostname, () =>
        socket.write(
          "GET http://[ HTTP/1.1\r\nHost: e2e\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
            "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        ),
      );
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
    });
    expect((await api("/healthz")).status).toBe(200);
  });

  it("is refused on an unknown path", async () => {
    await expect(track(openSocket("/webrtc/signaling/other"))).rejects.toThrow(
      /rejected/,
    );
  });
});

describe("signaling between the owner and the device", () => {
  it("tells the client which firmware and hardware the device runs", async () => {
    await connectDevice();
    const client = messages(await connectClient());
    expect(await client.next()).toEqual({
      type: "device-metadata",
      data: { deviceVersion: "0.5.0", deviceSku: "jetkvm-v2-sdmmc" },
    });
  });

  it("reports the original JetKVM for a device that sends an unknown SKU", async () => {
    await connectDevice({ "x-device-sku": "jetkvm-v9" });
    const client = messages(await connectClient());
    expect((await client.next()).data.deviceSku).toBe("jetkvm-v2");
  });

  it("forwards the offer with the device's public IP, ICE servers and the user's ID token", async () => {
    const device = messages(await connectDevice());
    const clientWs = await connectClient();
    const client = messages(clientWs);
    await client.next(); // device-metadata

    clientWs.send(JSON.stringify({ type: "offer", data: { sd: "offer-sdp" } }));
    expect(await device.next()).toEqual({
      type: "offer",
      data: {
        sd: "offer-sdp",
        ip: DEVICE_IP,
        iceServers: [inject("iceServer")],
        OidcGoogle: idTokenFor(OWNER),
      },
    });
  });

  it("relays the answer and ICE candidates both ways", async () => {
    const deviceWs = await connectDevice();
    const device = messages(deviceWs);
    const clientWs = await connectClient();
    const client = messages(clientWs);
    await client.next(); // device-metadata

    deviceWs.send(JSON.stringify({ type: "answer", data: "answer-sdp" }));
    expect(await client.next()).toEqual({ type: "answer", data: "answer-sdp" });

    deviceWs.send(
      JSON.stringify({ type: "new-ice-candidate", data: { candidate: "from-device" } }),
    );
    expect(await client.next()).toEqual({
      type: "new-ice-candidate",
      data: { candidate: "from-device" },
    });

    clientWs.send(
      JSON.stringify({ type: "new-ice-candidate", data: { candidate: "from-client" } }),
    );
    expect(await device.next()).toEqual({
      type: "new-ice-candidate",
      data: { candidate: "from-client" },
    });
  });

  it("answers the client's keepalive", async () => {
    await connectDevice();
    const clientWs = await connectClient();
    const client = messages(clientWs);
    await client.next(); // device-metadata

    clientWs.send("ping");
    expect(await client.next()).toBe("pong");
  });

  it("closes the client when the device goes away", async () => {
    const deviceWs = await connectDevice();
    const clientWs = await connectClient();
    const clientClosed = closed(clientWs);

    deviceWs.close();
    await clientClosed;
  });
});
