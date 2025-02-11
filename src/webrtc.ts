import { WebSocket, WebSocketServer } from "ws";
import express from "express";
import * as jose from "jose";
import { prisma } from "./db";
import { NotFoundError, UnprocessableEntityError } from "./errors";
import { IncomingMessage } from "http";
import { Socket } from "node:net";
import { Device } from "@prisma/client";

export const activeConnections: Map<string, [WebSocket, string]> = new Map();
export const inFlight: Set<string> = new Set();

function toICEServers(str: string) {
  return str.split(",").filter(
    (url) => url.startsWith("stun:")
  );
}

export const iceServers = toICEServers(
  process.env.ICE_SERVERS || "stun.cloudflare.com:3478,stun:stun.l.google.com:19302,stun:stun1.l.google.com:5349"
);

export const CreateSession = async (req: express.Request, res: express.Response) => {
  const idToken = req.session?.id_token;
  const { sub } = jose.decodeJwt(idToken);

  const { id, sd } = req.body;

  if (!id) throw new UnprocessableEntityError("Missing id");
  if (!sd) throw new UnprocessableEntityError("Missing sd");

  const device = await prisma.device.findUnique({
    where: { id, user: { googleId: sub } },
    select: { id: true },
  });

  if (!device) {
    throw new NotFoundError("Device not found");
  }

  if (inFlight.has(id)) {
    console.log(`Websocket for ${id} in-flight with another client`);
    throw new UnprocessableEntityError(
      `Websocket for ${id} in-flight with another client`,
    );
  }

  const wsTuple = activeConnections.get(id);
  if (!wsTuple) {
    console.log("No socket for id", id);
    throw new NotFoundError(`No socket for id found`, "kvm_socket_not_found");
  }

  // extract the websocket and ip from the tuple
  const [ws, ip] = wsTuple;

  let wsRes: ((value: unknown) => void) | null = null,
    wsRej: ((value: unknown) => void) | null = null;

  let timeout: NodeJS.Timeout | undefined;

  try {
    inFlight.add(id);
    const resp: any = await new Promise((res, rej) => {
      timeout = setTimeout(() => {
        rej(new Error("Timeout waiting for response from ws"));
      }, 5000);

      // Hoist the res and rej functions to be used in the finally block for cleanup
      wsRes = res;
      wsRej = rej;

      ws.addEventListener("message", wsRes);
      ws.addEventListener("error", wsRej);
      ws.addEventListener("close", wsRej);

      // If the HTTP client closes the connection before the websocket response is received, reject the promise
      req.socket.on("close", wsRej);

      ws.send(JSON.stringify({
        sd,
        ip,
        iceServers,
        OidcGoogle: idToken
      }));
    });

    return res.json(JSON.parse(resp.data));
  } catch (e) {
    console.error(`Error sending data to kvm with ${id}`, e);

    // If there was an error, remove the socket from the map
    ws.close(); // Most likely there is no-one on the other end to close the connection
    activeConnections.delete(id);

    return res
      .status(500)
      .json({ error: "There was an error sending and receiving data to the KVM" });
  } finally {
    if (timeout) clearTimeout(timeout);
    inFlight.delete(id);
    if (wsRes && wsRej) {
      ws.removeEventListener("message", wsRes);
      ws.removeEventListener("error", wsRej);
      ws.removeEventListener("close", wsRej);
    }
  }
};

export const CreateIceCredentials = async (
  req: express.Request,
  res: express.Response,
) => {
  const resp = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CLOUDFLARE_TURN_ID}/credentials/generate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_TURN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: 3600 }),
    },
  );

  const data = (await resp.json()) as {
    iceServers: { credential?: string; urls: string | string[]; username?: string };
  };

  if (!data.iceServers.urls) {
    throw new Error("No ice servers returned");
  }

  if (data.iceServers.urls instanceof Array) {
    data.iceServers.urls = data.iceServers.urls.filter(url => !url.startsWith("turns"));
  }

  return res.json(data);
};

export const CreateTurnActivity = async (req: express.Request, res: express.Response) => {
  const idToken = req.session?.id_token;
  const { sub } = jose.decodeJwt(idToken);
  const { bytesReceived, bytesSent } = req.body;

  await prisma.turnActivity.create({
    data: {
      bytesReceived,
      bytesSent,
      user: { connect: { googleId: sub } },
    },
  });

  return res.json({ success: true });
};

async function updateDeviceLastSeen(id: string) {
  const device = await prisma.device.findUnique({ where: { id } });
  if (device) {
    return prisma.device.update({ where: { id }, data: { lastSeen: new Date() } });
  }
}

export const registerWebsocketServer = (server: any) => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const authHeader = req.headers["authorization"];
    const secretToken = authHeader?.split(" ")?.[1];
    if (!secretToken) {
      console.log("No authorization header provided. Closing socket.");
      return socket.destroy();
    }

    let device: Device | null = null;
    try {
      device = await prisma.device.findFirst({ where: { secretToken } });
    } catch (error) {
      console.log("There was an error validating the secret token", error);
      return socket.destroy();
    }

    if (!device) {
      console.log("Invalid secret token provided. Closing socket.");
      return socket.destroy();
    }

    if (activeConnections.has(device.id)) {
      console.log(
        "Device already in active connection list. Terminating & deleting existing websocket.",
      );
      activeConnections.get(device.id)?.[0]?.terminate();
      activeConnections.delete(device.id);
    }

    wss.handleUpgrade(req, socket, head, function done(ws) {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", async function connection(ws, req) {
    const authHeader = req.headers["authorization"];
    const secretToken = authHeader?.split(" ")?.[1];

    let device: Device | null = null;
    try {
      device = await prisma.device.findFirst({ where: { secretToken } });
    } catch (error) {
      ws.send("There was an error validating the secret token. Closing ws connection.");
      console.log("There was an error validating the secret token", error);
      return ws.close();
    }

    if (!device) {
      ws.send("Invalid secret token provided. Closing ws connection.");
      console.log("Invalid secret token provided. Closing ws connection.");
      return ws.close();
    }

    const id = req.headers["x-device-id"] as string | undefined;
    const hasId = !!id;

    // Ensure id is provided
    if (!hasId) {
      ws.send("No id provided. Closing ws connection.");
      console.log("No id provided. Closing ws connection.");
      return ws.close();
    }

    if (!id) {
      ws.send("Invalid id provided. Closing ws connection.");
      console.log("Invalid id provided. Closing ws connection.");
      return ws.close();
    }

    if (id !== device.id) {
      ws.send("Id and token mismatch. Closing ws connection.");
      console.log("Id and token mismatch. Closing ws connection.");
      return ws.close();
    }

    // Ensure id is not inflight
    if (inFlight.has(id)) {
      ws.send(`ID, ${id} is in flight. Please try again.`);
      console.log(`ID, ${id} is in flight. Please try again.`);
      return ws.close();
    }

    const ip = (
      process.env.REAL_IP_HEADER && req.headers[process.env.REAL_IP_HEADER]
    ) || req.socket.remoteAddress;

    activeConnections.set(id, [ws, `${ip}`]);
    console.log("New socket for id", id);

    ws.on("error", async () => {
      if (!id) return;
      console.log("WS Error - Remove socket ", id);
      activeConnections.delete(id);
      await updateDeviceLastSeen(id);
    });

    ws.on("close", async () => {
      if (!id) return;
      console.log("WS Close - Remove socket ", id);
      activeConnections.delete(id);
      await updateDeviceLastSeen(id);
    });
  });
};
