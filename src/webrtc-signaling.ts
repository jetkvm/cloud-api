// src/webrtc.ts

import { MessageEvent, WebSocket, WebSocketServer } from "ws";
import * as jose from "jose";
import { prisma } from "./db";
import { IncomingMessage } from "http";
import { Socket } from "node:net";
import { Device } from "@prisma/client";
import { Server, ServerResponse } from "node:http";
import { cookieSessionMiddleware } from ".";

// Maintain the shared state
export const activeConnections: Map<string, [WebSocket, string, string | null]> =
  new Map(); //  [deviceWs, ip, version]
export const inFlight: Set<string> = new Set();

function toICEServers(str: string) {
  return str.split(",").filter(url => url.startsWith("stun:"));
}

export const iceServers = toICEServers(
  process.env.ICE_SERVERS ||
    "stun.cloudflare.com:3478,stun:stun.l.google.com:19302,stun:stun1.l.google.com:5349",
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
      return socket.destroy();
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
      return socket.destroy();
    }

    // Inflight means that the device has connected, a client has connected to that device via HTTP, and they're now doing the signaling dance
    if (inFlight.has(device.id)) {
      console.log(
        `[Device WS] Device ${device.id} already has an inflight client connection.`,
      );
      return socket.destroy();
    }

    // Handle existing connections for this device
    if (activeConnections.has(device.id)) {
      console.log(
        `[Device WS] Device ${device.id} already connected. Terminating existing connection.`,
      );
      activeConnections.get(device.id)?.[0]?.terminate();
      activeConnections.delete(device.id);
      // We don't return here, we just delete the existing connection and let it continue and create a new one.
      // Why multiple connections are needed, i don't know, but let's cover it.
    }

    // Complete the WebSocket upgrade
    wssDevice.handleUpgrade(req, socket, head, ws => {
      setupDeviceWebSocket(ws, device, req);
    });
  } catch (error) {
    console.error("Error handling device socket request:", error);
    socket.destroy();
  }
}

// Authenticate the device connection
async function authenticateDeviceRequest(req: IncomingMessage) {
  const authHeader = req.headers["authorization"];
  const secretToken = authHeader?.split(" ")?.[1];

  if (!secretToken) {
    console.log("[Device WS] No authorization header provided.");
    return null;
  }

  try {
    const device = await prisma.device.findFirst({ where: { secretToken } });
    if (!device) {
      console.log("[Device WS] Invalid secret token provided.");
      return null;
    }

    const id = req.headers["x-device-id"] as string;
    if (!id || id !== device.id) {
      console.log("[Device WS] Invalid device ID or ID/token mismatch.");
      return null;
    }

    return device;
  } catch (error) {
    console.error("[Device WS] Error authenticating device:", error);
    return null;
  }
}

// Setup the device WebSocket after authentication
function setupDeviceWebSocket(deviceWs: WebSocket, device: Device, req: IncomingMessage) {
  const id = device.id;
  const ip =
    (process.env.REAL_IP_HEADER && req.headers[process.env.REAL_IP_HEADER]) ||
    req.socket.remoteAddress;

  const deviceVersion = req.headers["x-app-version"] as string | null;

  // Store the connection
  activeConnections.set(id, [deviceWs, `${ip}`, deviceVersion || null]);
  console.log(
    `[Device WS] New connection for device ${id}, with version ${deviceVersion || "unknown"}`,
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
      console.log("[Device WS] WS is not alive. Terminating connection.");
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

  deviceWs.on("close", async () => {
    console.log(`[Device] Connection closed for ${id}`);
    await cleanup();
  });

  // Cleanup function
  async function cleanup() {
    activeConnections.delete(id);
    clearInterval(checkAliveInterval);
    console.log(`[Device] Cleanup for ${id}`);
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
        const { deviceId, token } = await authenticateClientRequest(req as any);
        if (!deviceId) {
          return socket.destroy();
        }

        // Check if device is connected
        if (!activeConnections.has(deviceId)) {
          console.log(`[Client] Device ${deviceId} not connected.`);
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          return socket.destroy();
        }

        // Complete the WebSocket upgrade
        wssClient.handleUpgrade(req, socket, head, ws => {
          setupClientWebSocket(ws, deviceId, token);
        });
      } catch (error) {
        console.error("Error in client WebSocket setup:", error);
        socket.destroy();
      }
    });
  } catch (error) {
    console.error("Error handling client socket request:", error);
    socket.destroy();
  }
}

// Authenticate the client connection
async function authenticateClientRequest(req: Request & { session: any }) {
  const session = req.session;
  const token = session?.id_token;

  if (!token) {
    console.log("[Client] No authentication token.");
    return { deviceId: null };
  }

  try {
    const { sub } = jose.decodeJwt(token);
    const url = new URL(req.url || "", "http://localhost");
    const deviceId = url.searchParams.get("id");

    if (!deviceId) {
      console.log("[Client] No device ID provided.");
      return { deviceId: null };
    }

    // Check if device exists and user has access
    const device = await prisma.device.findUnique({
      where: { id: deviceId, user: { googleId: sub } },
      select: { id: true },
    });

    if (!device) {
      console.log("[Client] Device not found or user doesn't have access.");
      return { deviceId: null };
    }

    return { deviceId, token };
  } catch (error) {
    console.error("[Client] Authentication error:", error);
    return { deviceId: null };
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

  const [deviceWs, ip, version] = deviceConn;

  // If there's an active connection with this device, prevent a new one
  if (inFlight.has(deviceId)) {
    console.log(`[Client] Device ${deviceId} already has an active client connection.`);
    return clientWs.close();
  }

  console.log("[Client] Sending client connected message to device", version);

  clientWs.send(
    JSON.stringify({
      type: "device-metadata",
      data: { deviceVersion: version },
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
