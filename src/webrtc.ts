import express from "express";
import { prisma } from "./db";
import { NotFoundError, UnauthorizedError, UnprocessableEntityError } from "./errors";
import { activeConnections, iceServers, inFlight } from "./webrtc-signaling";

export const CreateSession = async (req: express.Request, res: express.Response) => {
  const { subject } = req;
  if (!subject) throw new UnauthorizedError("Missing subject in token");

  const { id, sd } = req.body;
  if (!id) throw new UnprocessableEntityError("Missing id");
  if (!sd) throw new UnprocessableEntityError("Missing sd");

  const device = await prisma.device.findUnique({
    where: { id, user: { googleId: subject } },
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
  const session = req.session;
  if (!session) throw new UnauthorizedError("No session found");

  const idToken = session.id_token;
  if (!idToken) throw new UnauthorizedError("No ID token found in session");

  const connectionMessage = JSON.stringify({ sd, ip, iceServers, OidcGoogle: idToken })

  let timeout: ReturnType<typeof setTimeout> | undefined;

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
      ws.send(connectionMessage);
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

  if (Array.isArray(data.iceServers.urls)) {
    data.iceServers.urls = data.iceServers.urls.filter(url => !url.startsWith("turns"));
  }

  return res.json(data);
};

export const CreateTurnActivity = async (req: express.Request, res: express.Response) => {
  const { subject } = req;
  if (!subject) throw new UnauthorizedError("Missing subject in token");

  const { bytesReceived, bytesSent } = req.body;

  await prisma.turnActivity.create({
    data: {
      bytesReceived,
      bytesSent,
      user: { connect: { googleId: subject } },
    },
  });

  return res.json({ success: true });
};
