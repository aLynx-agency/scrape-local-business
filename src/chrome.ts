import { chromium, type Browser, type BrowserContext } from "playwright";
import { STEALTH_INIT_SCRIPT } from "./stealth.ts";

const CDP_PORT = process.env.CDP_PORT ?? "9222";
// Use 127.0.0.1 explicitly — `localhost` resolves to ::1 (IPv6) first on Node 20+
// while Chrome's --remote-debugging-port only listens on IPv4 by default.
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

let cached: { browser: Browser; context: BrowserContext } | null = null;

export async function connect(): Promise<{ browser: Browser; context: BrowserContext }> {
  if (cached && cached.browser.isConnected()) return cached;

  if (!(await isReachable())) {
    throw new Error(
      `Browser CDP not reachable at ${CDP_URL}. Start the browser first with \`npm run chrome\` (or \`HEADLESS=true npm run chrome\`).`,
    );
  }

  const browser = await chromium.connectOverCDP(CDP_URL);
  // When connecting over CDP, the existing default context is reused.
  const contexts = browser.contexts();
  const context = contexts[0] ?? (await browser.newContext());

  // tsx transforms named functions/arrows in our source with `__name(fn, "name")`
  // calls. When that code runs inside `page.evaluate` it executes in the browser,
  // where `__name` is undefined. Shim it once per context via init script.
  await context.addInitScript({ content: "globalThis.__name = globalThis.__name || function(fn){return fn;};" });

  // Anti-fingerprint shim — patches navigator.webdriver, plugins, languages,
  // chrome.runtime, WebGL renderer, etc. before any site JS runs. Required for
  // Google scraping past the first request, even with a residential proxy.
  await context.addInitScript({ content: STEALTH_INIT_SCRIPT });

  // Locale alignment for Belgian outreach queries: Accept-Language matches
  // navigator.languages from the stealth shim, geolocation pinned to Brussels.
  // Mismatch between any of (proxy country, Accept-Language, navigator.languages,
  // geolocation, timezone) is itself a fingerprint signal — Google flags
  // "browser claims US locale but exits via Belgian residential IP" inside
  // its first request.
  await context.setExtraHTTPHeaders({
    "Accept-Language": "en-BE,en;q=0.9,nl-BE;q=0.8,fr-BE;q=0.7",
  });
  // Brussels city center coordinates. Granted to google.com so any geolocation
  // probe (Local Finder uses these) returns plausible Belgian coords instead
  // of "permission denied" or default 0,0.
  await context.setGeolocation({ latitude: 50.8503, longitude: 4.3517 });
  await context.grantPermissions(["geolocation"], { origin: "https://www.google.com" });

  cached = { browser, context };
  return cached;
}

export async function isReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Defensive end-of-request cleanup: closes any non-blank pages still attached
 * to the context. Each individual close uses `runBeforeUnload: false` so sites
 * with "are you sure you want to leave?" dialogs cannot hang us.
 *
 * Safe to call multiple times. Pages we already closed properly are no-ops here
 * because they're no longer in `context.pages()`.
 */
export async function closeOpenedPages(): Promise<void> {
  if (!cached) return;
  const pages = cached.context.pages();
  await Promise.all(
    pages.map((page) => {
      const url = page.url();
      if (url === "about:blank" || url.startsWith("chrome://")) return Promise.resolve();
      return page.close({ runBeforeUnload: false }).catch(() => {});
    }),
  );
}
