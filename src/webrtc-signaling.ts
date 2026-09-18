// src/webrtc.ts

import { MessageEvent, WebSocket, WebSocketServer } from "ws";
import * as jose from "jose";
import { prisma } from "./db";
import { IncomingMessage } from "http";
import { Socket } from "node:net";
import { Device } from "@prisma/client";
import { STATUS_CODES, Server, ServerResponse } from "node:http";
import { cookieSessionMiddleware } from ".";
import { effectiveSku, normalizeSku } from "./skus";

export interface DeviceConnection {
  ws: WebSocket;
  ip: string;
  /** X-App-Version header, null for firmware that does not send it. */
  version: string | null;
  /** X-Device-SKU header after validation, null when absent or unknown. */
  sku: string | null;
}

// Maintain the shared state
export const activeConnections: Map<string, DeviceConnection> = new Map();
export const inFlight: Set<string> = new Set();

/**
 * Refuses an upgrade with a real HTTP response before closing the socket.
 *
 * Destroying the socket without a response makes the edge in front of the
 * API report the request as a 504, so every device holding a revoked token
 * showed up as a gateway failure on each of its 5-second retries.
 */
export function rejectUpgrade(socket: Socket, status: number) {
  if (!socket.writable) {
    return socket.destroy();
  }
  socket.once("finish", socket.destroy);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function toICEServers(str: string) {
  return str.split(",").filter(url => url.startsWith("stun:"));
}

export const iceServers = toICEServers(
  process.env.ICE_SERVERS ||
    "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302,stun:stun1.l.google.com:5349",
);

// Helper function to update device last seen timestamp
async function updateDeviceLastSeen(id: string) {
  const device = await prisma.device.findUnique({ where: { id } });
  if (device) {
    return prisma.device.update({ where: { id }, data: { lastSeen: new Date() } });
  }
}

const wssDevice = new WebSocketServer({ noServer: true });
const wssClient = new WebSocketServer({ noServer: true });

// WebSocket router - routes WebSocket connections based on URL path
export function registerWebSocketRouter(
  server: Server<typeof IncomingMessage, typeof ServerResponse>,
) {
  server.on("upgrade", async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url || "", "http://localhost"); // We don't care about the hostname, we're just using the path to route
    const path = url.pathname;

    // Route to appropriate handler based on path
    // This path should be something like /webrtc/signaling/device, but due to legacy reasons we have to use `/` for device ws regitstrations
    if (path === "/") {
      await handleDeviceSocketRequest(req, socket, head);
    } else if (path === "/webrtc/signaling/client") {
      await handleClientSocketRequest(req, socket, head);
    } else {
      console.log(`[Webrtc] Unrecognized path: ${path}`);
      return rejectUpgrade(socket, 404);
    }
  });
}

// ==========================================================================
// Device WebSocket handlers
// ==========================================================================

// Handle device WebSocket connection requests
async function handleDeviceSocketRequest(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
) {
  try {
    // Authenticate device
    const device = await authenticateDeviceRequest(req);
    if (!device) {
      return rejectUpgrade(socket, 401);
    }

    // Inflight means that the device has connected, a client has connected to that device via HTTP, and they're now doing the signaling dance
    if (inFlight.has(device.id)) {
      console.log(
        `[Device] Device ${device.id} already has an inflight client connection.`,
      );
      return rejectUpgrade(socket, 409);
    }

    // Handle existing connections for this device
    if (activeConnections.has(device.id)) {
      console.log(
        `[Device] Device ${device.id} already connected. Terminating existing connection.`,
      );

      const existingDeviceWs = activeConnections.get(device.id)!.ws;
      await new Promise(resolve => {
        console.log("[Device] Waiting for existing connection to close...");
        existingDeviceWs.on("close", () => {
          activeConnections.delete(device.id);
          console.log("[Device] Existing connection closed.");

          // Now we continue with the new connection
          resolve(true);
        });

        existingDeviceWs.terminate();
      });
    }

    // Complete the WebSocket upgrade
    wssDevice.handleUpgrade(req, socket, head, ws => {
      setupDeviceWebSocket(ws, device, req);
    });
  } catch (error) {
    console.error("Error handling device socket request:", error);
    rejectUpgrade(socket, 500);
  }
}

// Authenticate the device connection
async function authenticateDeviceRequest(req: IncomingMessage) {
  const authHeader = req.headers["authorization"];
  const secretToken = authHeader?.split(" ")?.[1];

  if (!secretToken) {
    console.log("[Device] No authorization header provided.");
    return null;
  }

  try {
    const device = await prisma.device.findFirst({ where: { secretToken } });
    if (!device) {
      console.log("[Device] Invalid secret token provided.");
      return null;
    }

    const id = req.headers["x-device-id"] as string;
    if (!id || id !== device.id) {
      console.log("[Device] Invalid device ID or ID/token mismatch.");
      return null;
    }

    return device;
  } catch (error) {
    console.error("[Device] Error authenticating device:", error);
    return null;
  }
}

// Setup the device WebSocket after authentication
function setupDeviceWebSocket(deviceWs: WebSocket, device: Device, req: IncomingMessage) {
  const id = device.id;
  const ip =
    (process.env.REAL_IP_HEADER && req.headers[process.env.REAL_IP_HEADER]) ||
    req.socket.remoteAddress;

  const deviceVersion = (req.headers["x-app-version"] as string | undefined) || null;
  const rawSku = req.headers["x-device-sku"];
  const deviceSku = normalizeSku(rawSku);
  if (rawSku && !deviceSku) {
    console.log(`[Device] ${id} reported unknown SKU ${JSON.stringify(rawSku)}; ignoring`);
  }

  // Store the connection
  activeConnections.set(id, { ws: deviceWs, ip: `${ip}`, version: deviceVersion, sku: deviceSku });
  console.log(
    `[Device] New connection for device ${id}, with version ${deviceVersion || "unknown"} and SKU ${deviceSku || "unknown"}`,
  );

  // Setup ping/pong for connection health checks
  // @ts-ignore
  deviceWs.isAlive = true;
  deviceWs.on("pong", function heartbeat() {
    // @ts-ignore
    this.isAlive = true;
  });

  const checkAliveInterval = setInterval(function checkAlive() {
    // @ts-ignore
    if (deviceWs.isAlive === false) {
      console.log(`[Device] ${id} is not alive. Terminating connection.`);
      return deviceWs.terminate();
    }
    // @ts-ignore
    deviceWs.isAlive = false;
    deviceWs.ping();
    // We check for aliveness every 10s
  }, 10000);

  // Handle errors and connection close
  deviceWs.on("error", async error => {
    console.log(`[Device] Error for ${id}:`, error);
    await cleanup();
  });

  deviceWs.on("close", async (code, reason) => {
    console.log(
      `[Device] Connection closed for ${id} with code ${code} and reason ${reason}`,
    );
    await cleanup();
  });

  // Cleanup function
  async function cleanup() {
    console.log(`[Device] Cleanup for ${id}`);
    activeConnections.delete(id);
    clearInterval(checkAliveInterval);
    await updateDeviceLastSeen(id);
  }
}

// ==========================================================================
// Client WebSocket handlers
// ==========================================================================

// Handle client WebSocket connection requests
async function handleClientSocketRequest(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
) {
  try {
    // Apply session middleware to access authentication
    cookieSessionMiddleware(req as any, {} as any, async () => {
      try {
        // Authenticate client and get device ID
        const auth = await authenticateClientRequest(req as any);
        if (auth.deviceId === null) {
          return rejectUpgrade(socket, auth.status);
        }
        const { deviceId, token } = auth;

        // Check if device is connected
        if (!activeConnections.has(deviceId)) {
          console.log(`[Client] Device ${deviceId} not connected.`);
          return rejectUpgrade(socket, 404);
        }

        // Complete the WebSocket upgrade
        wssClient.handleUpgrade(req, socket, head, ws => {
          setupClientWebSocket(ws, deviceId, token);
        });
      } catch (error) {
        console.error("Error in client WebSocket setup:", error);
        rejectUpgrade(socket, 500);
      }
    });
  } catch (error) {
    console.error("Error handling client socket request:", error);
    rejectUpgrade(socket, 500);
  }
}

type ClientAuth =
  | { deviceId: string; token: string }
  | { deviceId: null; status: 401 | 404 };

// Authenticate the client connection
async function authenticateClientRequest(
  req: Request & { session: any },
): Promise<ClientAuth> {
  const session = req.session;
  const token = session?.id_token;

  if (!token) {
    console.log("[Client] No authentication token.");
    return { deviceId: null, status: 401 };
  }

  try {
    const { sub } = jose.decodeJwt(token);
    const url = new URL(req.url || "", "http://localhost");
    const deviceId = url.searchParams.get("id");

    if (!deviceId) {
      console.log("[Client] No device ID provided.");
      return { deviceId: null, status: 404 };
    }

    // Check if device exists and user has access
    const device = await prisma.device.findUnique({
      where: { id: deviceId, user: { googleId: sub } },
      select: { id: true },
    });

    if (!device) {
      console.log("[Client] Device not found or user doesn't have access.");
      return { deviceId: null, status: 404 };
    }

    return { deviceId, token };
  } catch (error) {
    console.error("[Client] Authentication error:", error);
    return { deviceId: null, status: 401 };
  }
}

// Setup the client WebSocket after authentication
function setupClientWebSocket(clientWs: WebSocket, deviceId: string, token: string) {
  console.log(`[Client] New connection for device ${deviceId}`);

  // Get device WebSocket
  const deviceConn = activeConnections.get(deviceId);
  if (!deviceConn) {
    console.log(`[Client] No device connection for ${deviceId}`);
    return clientWs.close();
  }

  const { ws: deviceWs, ip, version, sku } = deviceConn;

  // If there's an active connection with this device, prevent a new one
  if (inFlight.has(deviceId)) {
    console.log(`[Client] Device ${deviceId} already has an active client connection.`);
    return clientWs.close();
  }

  console.log(
    "[Client] Sending client device-metadata, version:",
    version,
    " - ",
    deviceId,
  );

  clientWs.send(
    JSON.stringify({
      type: "device-metadata",
      data: { deviceVersion: version, deviceSku: effectiveSku(sku) },
    }),
  );

  // Handle message forwarding from client to device
  clientWs.on("message", data => {
    // Handle ping/pong
    if (data.toString() === "ping") return clientWs.send("pong");

    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case "offer":
          console.log(`[Client] Sending offer to device ${deviceId}`);
          deviceWs.send(
            JSON.stringify({
              type: "offer",
              data: {
                sd: msg.data.sd,
                ip,
                iceServers,
                OidcGoogle: token,
              },
            }),
          );
          break;

        case "new-ice-candidate":
          console.log(`[Client] Sending ICE candidate to device ${deviceId}`);
          deviceWs.send(
            JSON.stringify({
              type: "new-ice-candidate",
              data: msg.data,
            }),
          );
          break;
      }
    } catch (error) {
      console.error(`[Client] Error processing message for ${deviceId}:`, error);
    }
  });

  // Handle message forwarding from device to client
  const deviceMessageHandler = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string);

      switch (msg.type) {
        case "answer":
          console.log(`[Device] Sending answer to client for ${deviceId}`);
          clientWs.send(JSON.stringify({ type: "answer", data: msg.data }));
          break;

        case "new-ice-candidate":
          console.log(`[Device] Sending ICE candidate to client for ${deviceId}`);
          clientWs.send(JSON.stringify({ type: "new-ice-candidate", data: msg.data }));
          break;
      }
    } catch (error) {
      console.error(`[Device] Error processing message for ${deviceId}:`, error);
    }
  };

  // Store original handlers so we can restore them
  const originalHandlers = {
    onmessage: deviceWs.onmessage,
    onerror: deviceWs.onerror,
    onclose: deviceWs.onclose,
  };

  // Set up device -> client message handling
  deviceWs.onmessage = deviceMessageHandler;

  // Handle device errors and disconnections
  deviceWs.onerror = () => {
    console.log(`[Device] Error, closing client connection for ${deviceId}`);
    cleanup();
    clientWs.close();
  };

  deviceWs.onclose = () => {
    console.log(`[Device] Closed, terminating client connection for ${deviceId}`);
    cleanup();
    clientWs.terminate();
  };

  // Handle client disconnection
  clientWs.on("close", () => {
    console.log(`[Client] Connection closed for ${deviceId}`);
    cleanup();
  });

  // Cleanup function
  function cleanup() {
    // Restore original device handlers
    deviceWs.onmessage = originalHandlers.onmessage;
    deviceWs.onerror = originalHandlers.onerror;
    deviceWs.onclose = originalHandlers.onclose;

    // Remove from in-flight set
    inFlight.delete(deviceId);
  }
}

// Export a single initialization function
export function initializeWebRTCSignaling(
  server: Server<typeof IncomingMessage, typeof ServerResponse>,
) {
  registerWebSocketRouter(server);
}
