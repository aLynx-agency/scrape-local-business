// Local auth-proxy relay with sticky-session support.
//
// Why this exists:
//   1. Chrome's --proxy-server flag silently drops inline credentials
//      (http://user:pass@host:port → user:pass discarded), so auth proxies
//      can't be wired in directly. The relay handles upstream auth and exposes
//      a no-auth localhost endpoint that Chrome can use via PROXY_SERVER.
//
//   2. Residential proxies rotate exit IPs per-connection by default. Google
//      binds CAPTCHA challenges to the originating IP and rejects the
//      submission if a different IP submits the token (you'll see "IP address:
//      X ≠ Y" on the /sorry/ page). To avoid this, every request in a scrape
//      session needs the same exit. We inject a sticky-session tag into the
//      proxy username so the upstream pins one IP for our session.
//
// Run: npm run proxy-relay  (loads UPSTREAM_PROXY + RELAY_PORT from .env)
//
// Env:
//   UPSTREAM_PROXY            http://user:pass@host:port  (required)
//   RELAY_PORT                port to listen on locally (default 8888)
//   STICKY_SESSION_FORMAT     username suffix template; "{id}" is replaced
//                             with a random session id. Default is
//                             "__session.{id}" — DataImpulse's syntax. Set to
//                             empty string to disable injection. Other
//                             providers may use "-session-{id}", "__sid.{id}",
//                             etc. — check your provider's docs.
//   SESSION_ROTATE_MINUTES    auto-rotate the session id every N minutes.
//                             Default 0 (never — one IP for the relay lifetime).

import { Server } from "proxy-chain";
import crypto from "node:crypto";

const upstream = process.env.UPSTREAM_PROXY;
const port = Number(process.env.RELAY_PORT ?? 8888);
const stickyFormat = process.env.STICKY_SESSION_FORMAT ?? "__session.{id}";
const rotateMinutes = Number(process.env.SESSION_ROTATE_MINUTES ?? 0);

if (!upstream) {
  console.error("ERROR: UPSTREAM_PROXY env var required (e.g. http://user:pass@host:port)");
  process.exit(1);
}

let sessionId = newSessionId();
let nextRotateAt = rotateMinutes > 0 ? Date.now() + rotateMinutes * 60_000 : Infinity;

function newSessionId() {
  return crypto.randomBytes(6).toString("hex");
}

function buildUpstream() {
  if (Date.now() > nextRotateAt) {
    sessionId = newSessionId();
    nextRotateAt = Date.now() + rotateMinutes * 60_000;
    console.log(`[proxy-relay] rotated sticky session id → ${sessionId}`);
  }
  if (!stickyFormat) return upstream;
  // Insert the session tag into the username portion only:
  //   http://USER:PASS@HOST:PORT  →  http://USER<tag>:PASS@HOST:PORT
  const tag = stickyFormat.replace("{id}", sessionId);
  return upstream.replace(/^(https?:\/\/[^:@]+)/, `$1${tag}`);
}

const masked = upstream.replace(/\/\/[^@]+@/, "//***:***@");

const server = new Server({
  port,
  host: "127.0.0.1",
  prepareRequestFunction: () => ({ upstreamProxyUrl: buildUpstream() }),
});

server.listen(() => {
  console.log(
    `[proxy-relay] listening on 127.0.0.1:${port} → ${masked} ` +
      `(sticky: ${stickyFormat ? `${stickyFormat} id=${sessionId}` : "<off>"}` +
      `${rotateMinutes > 0 ? `, rotate every ${rotateMinutes}m` : ""})`,
  );
});

server.on("requestFailed", ({ request, error }) => {
  console.warn(`[proxy-relay] request failed: ${request?.url ?? "?"} — ${error.message}`);
});

const shutdown = () => {
  console.log("[proxy-relay] shutting down…");
  server.close(true).finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
