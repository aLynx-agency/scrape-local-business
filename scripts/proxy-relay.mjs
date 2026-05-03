// Local auth-proxy relay.
//
// Why this exists: Chrome's --proxy-server flag silently drops inline
// credentials (http://user:pass@host:port → user:pass is discarded), so auth
// proxies can't be wired in directly. This relay listens on a no-auth
// localhost port and forwards every request to the upstream proxy with the
// credentials attached. Chrome talks to the relay, the relay handles auth.
//
// Run: npm run proxy-relay  (loads UPSTREAM_PROXY + RELAY_PORT from .env)
//
// Env:
//   UPSTREAM_PROXY  http://user:pass@host:port  (required)
//   RELAY_PORT      port to listen on locally (default 8888)

import { Server } from "proxy-chain";

const upstream = process.env.UPSTREAM_PROXY;
const port = Number(process.env.RELAY_PORT ?? 8888);

if (!upstream) {
  console.error("ERROR: UPSTREAM_PROXY env var required (e.g. http://user:pass@host:port)");
  process.exit(1);
}

const masked = upstream.replace(/\/\/[^@]+@/, "//***:***@");

const server = new Server({
  port,
  host: "127.0.0.1",
  prepareRequestFunction: () => ({ upstreamProxyUrl: upstream }),
});

server.listen(() => {
  console.log(`[proxy-relay] listening on 127.0.0.1:${port} → ${masked}`);
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
