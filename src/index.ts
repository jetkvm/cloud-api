import express from "express";
import cors from "cors";
import cookieSession from "cookie-session";
import helmet from "helmet";
import 'dotenv/config';

import * as Devices from "./devices";
import * as OIDC from "./oidc";
import * as Webrtc from "./webrtc";
import * as Releases from "./releases";

import { HttpError } from "./errors";
import { authenticated } from "./auth";
import { prisma } from "./db";
import { initializeWebRTCSignaling } from "./webrtc-signaling";

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV: "development" | "production";
      PORT: string;

      API_HOSTNAME: string;
      APP_HOSTNAME: string;
      COOKIE_SECRET: string;

      // We use Google OIDC for authentication
      GOOGLE_CLIENT_ID: string;
      GOOGLE_CLIENT_SECRET: string;

      // We use Cloudflare STUN & TURN server for cloud users
      CLOUDFLARE_TURN_ID: string;
      CLOUDFLARE_TURN_TOKEN: string;

      // We use R2 for storing releases
      R2_ENDPOINT: string;
      R2_ACCESS_KEY_ID: string;
      R2_SECRET_ACCESS_KEY: string;
      R2_BUCKET: string;
      R2_CDN_URL: string;

      CORS_ORIGINS: string;

      // Real IP
      REAL_IP_HEADER: string;
      ICE_SERVERS: string;
    }
  }
}

const PORT = process.env.PORT || 3000;

const app = express();
app.use(helmet());
app.disable("x-powered-by");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: process.env.CORS_ORIGINS?.split(",") || [
      "https://app.jetkvm.com",
      "http://localhost:5173",
    ],
    credentials: true,
  }),
);
export const cookieSessionMiddleware = cookieSession({
  name: "session",
  path: "/",
  httpOnly: true,
  keys: [process.env.COOKIE_SECRET],
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
});

app.use(cookieSessionMiddleware);

// express-session won't sent the cookie, as it's `secure` and `secureProxy` is set to true
// DO Apps doesn't send a X-Forwarded-Proto header, so we simply need to make a blanket trust
app.set("trust proxy", true);

app.get("/", (req, res) => {
  return res.status(200).send("OK");
});

app.get("/healthz", (req, res) => {
  return res.status(200).send({
    ready: true,
    time: new Date()
  })
});

app.get(
  "/me",
  authenticated,
  async (req: express.Request, res: express.Response) => {
    const { subject, issuer } = req;
    if (!subject || !issuer) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    let user;
    if (issuer === "https://accounts.google.com") {
      user = await prisma.user.findUnique({
        where: { googleId: subject },
        select: { picture: true, email: true },
      });
    }

    return res.json({ ...user, subject });
  },
);

app.get("/releases", Releases.Retrieve);
app.get("/releases/system_recovery/latest", Releases.RetrieveLatestSystemRecovery);
app.get("/releases/app/latest", Releases.RetrieveLatestApp);

app.get("/devices", authenticated, Devices.List);
app.get("/devices/:id", authenticated, Devices.Retrieve);
app.post("/devices/token", Devices.Token);
app.put("/devices/:id", authenticated, Devices.Update);
app.delete("/devices/:id", Devices.Delete);

app.post("/webrtc/session", authenticated, Webrtc.CreateSession);
app.post("/webrtc/ice_config", authenticated, Webrtc.CreateIceCredentials);
app.post("/webrtc/turn_activity", authenticated, Webrtc.CreateTurnActivity);

app.post("/oidc/google", OIDC.Google);
app.get("/oidc/callback_o", OIDC.Callback);
app.get("/oidc/callback", (req, res) => {
  /*
   * We set the session cookie in the /oidc/google route as a part of 302 redirect to the OIDC login page
   * When the OIDC provider redirects back to the /oidc/callback route, the session cookie won't be sent as it seen by the browser as a new session,
   * and SameSite=Lax|Strict doesn't regard it as a same-site request.
   *
   * One solution, is to simply to use SameSite=None; Secure. Not nice for CSRF, and safari doesn't like it.
   * Another solution is to simply return 200 and then redirect with HTML to the /oidc/callback_o route, which will have the session cookie.
   * We went with the latter, and now we can have SameSite=Strict cookies:
   * https://stackoverflow.com/questions/42216700/how-can-i-redirect-after-oauth2-with-samesite-strict-and-still-get-my-cookies
   * */
  const callbackUrl = req.url.replace("/oidc/callback", "/oidc/callback_o");
  return res.send(
    `<html>
      <head>
        <meta http-equiv="refresh" content="0; URL='${callbackUrl}'"/>
        <script>
          // Initial theme setup
          document.documentElement.classList.toggle(
            "dark",
            localStorage.theme === "dark" ||
              (!("theme" in localStorage) &&
                window.matchMedia("(prefers-color-scheme: dark)").matches),
          );

          // Listen for system theme changes
          window
            .matchMedia("(prefers-color-scheme: dark)")
            .addEventListener("change", ({ matches }) => {
              if (!("theme" in localStorage)) {
                // Only auto-switch if user hasn't manually set a theme
                document.documentElement.classList.toggle("dark", matches);
              }
            });
        </script>
        <style>
          body {background-color: #0f172a;}
        </style>
      </head>
      <body></body>
    </html>`,
  );
});

app.post(
  "/logout",
  (req: express.Request, res: express.Response) => {
    req.session = null;
    return res.json({ message: "Logged out" });
  }
);

// Error-handling middleware
app.use(
  (
    err: HttpError | Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    const isProduction = process.env.NODE_ENV === "production";
    const statusCode = err instanceof HttpError ? err.status : 500;

    // Build the error response payload
    const payload = {
      name: err.name,
      message: err.message,
      ...(isProduction ? {} : { stack: err.stack }),
    };

    console.error(err);

    res.status(statusCode).json(payload);
  },
);

const server = app.listen(PORT, () => {
  console.log("Server started on port " + PORT);
});

initializeWebRTCSignaling(server);
