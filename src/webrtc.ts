import { WebSocket, WebSocketServer } from "ws";
import express from "express";
import * as jose from "jose";
import * as crypto from "crypto";
import { prisma } from "./db";
import { BadRequestError, InternalServerError, NotFoundError, UnprocessableEntityError } from "./errors";
import { activeConnections, iceServers, inFlight } from "./webrtc-signaling";

const CLOUDFLARE_TURN_ID = process.env.CLOUDFLARE_TURN_ID;
const CLOUDFLARE_TURN_TOKEN = process.env.CLOUDFLARE_TURN_TOKEN;
const COTURN_TURN_URLS = process.env.COTURN_TURN_URLS?.split(",")
  .map(url => url.trim())
  .filter(Boolean);
const COTURN_TURN_SECRET = process.env.COTURN_TURN_SECRET;
const TURN_TTL = Number.parseInt(process.env.TURN_TTL ?? "", 10) || 3600;

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

  let timeout: NodeJS.Timeout | undefined;

  let httpClose: (() => void) | null = null;

  try {
    inFlight.add(id);
    const resp: any = await new Promise((res, rej) => {
      timeout = setTimeout(() => {
        rej(new Error("Timeout waiting for response from ws"));
      }, 15000);

      ws.onerror = rej;
      ws.onclose = rej;
      ws.onmessage = res;

      httpClose = () => {
        rej(new Error("HTTP client closed the connection"));
      };

      // If the HTTP client closes the connection before the websocket response is received, reject the promise
      req.socket.on("close", httpClose);

      ws.send(
        JSON.stringify({
          sd,
          ip,
          iceServers,
          OidcGoogle: idToken,
        }),
      );
    });

    console.log("[CreateSession] got response from device", id);
    return res.json(JSON.parse(resp.data));
  } catch (e) {
    console.log(`Error sending data to kvm with ${id}`, e);

    return res
      .status(500)
      .json({ error: "There was an error sending and receiving data to the KVM" });
  } finally {
    if (timeout) clearTimeout(timeout);
    console.log("Removing in flight", id);
    inFlight.delete(id);

    if (httpClose) {
      console.log("Removing http close listener", id);
      req.socket.off("close", httpClose);
    }

    if (ws) {
      console.log("Removing ws listeners", id);
      ws.onerror = null;
      ws.onclose = null;
      ws.onmessage = null;
    }
  }
};

export const CreateIceCredentials = async (
  req: express.Request,
  res: express.Response,
) => {
  const idToken = req.session?.id_token;
  if (!idToken) {
    throw new UnprocessableEntityError("Missing ID token");
  }
  const { sub } = jose.decodeJwt(idToken);

  let iceConfig: {
    iceServers: { urls: string | string[]; username?: string, credential?: string }
  };

  if (CLOUDFLARE_TURN_ID && CLOUDFLARE_TURN_TOKEN) {
    const resp = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${CLOUDFLARE_TURN_ID}/credentials/generate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_TURN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: TURN_TTL }),
      },
    );

    const cloudflareIceConfig = await resp.json() as {
      iceServers: { urls: string | string[]; username?: string, credential?: string }
    };

    if (!cloudflareIceConfig?.iceServers.urls) {
      throw new InternalServerError("No ice servers returned");
    }

    if (cloudflareIceConfig.iceServers.urls instanceof Array) {
      cloudflareIceConfig.iceServers.urls = cloudflareIceConfig.iceServers.urls.filter(url => !url.startsWith("turns"));
    }

    iceConfig = cloudflareIceConfig;
  } else if (COTURN_TURN_URLS && COTURN_TURN_SECRET && COTURN_TURN_URLS.length > 0) {
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${sub}`;
    const credential = crypto
      .createHmac("sha1", COTURN_TURN_SECRET)
      .update(username)
      .digest("base64");

    iceConfig = {
      iceServers: {
        urls: COTURN_TURN_URLS,
        username: username,
        credential: credential,
      }
    };
  } else {
    throw new BadRequestError("No TURN configuration available", "no_turn_configuration");
  }

  return res.json(iceConfig);
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
