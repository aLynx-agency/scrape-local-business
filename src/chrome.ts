import { chromium, type Browser, type BrowserContext } from "patchright";

// Patchright = Playwright fork that patches automation fingerprints at the
// CDP/C++ layer (navigator.webdriver, chrome.runtime, Runtime.enable traces,
// etc). Replaces the custom STEALTH_INIT_SCRIPT we used to ship — JS-shim
// stealth is itself detectable, native patches are not.
//
// We launch our own persistent context now instead of connecting over CDP to
// a user-launched Chrome. Patchright's biggest wins are at launch (removing
// --enable-automation, hiding CDP flags, channel:'chrome' uses the real
// Google Chrome binary). connectOverCDP would skip half the patches.

const USER_DATA_DIR = process.env.USER_DATA_DIR ?? "./chrome-profile";
const HEADLESS = process.env.HEADLESS === "true";
const CHROME_PATH = process.env.CHROME_PATH;
const PROXY_SERVER = process.env.PROXY_SERVER;

// Belgium locale stack. Every layer below must agree or the mismatch is itself
// a fingerprint signal:
//   - timezone: Europe/Brussels
//   - locale (Accept-Language + navigator.language): en-BE
//   - geolocation: Brussels city center
//   - navigator.languages preference chain: en-BE → en → nl-BE → fr-BE
// Coordinates from Brussels Grand Place. Granted to google.com so Local Finder
// can read them without a permission prompt.
const BRUSSELS_LAT = 50.8503;
const BRUSSELS_LON = 4.3517;
const LOCALE = "en-BE";
const TIMEZONE = "Europe/Brussels";
const ACCEPT_LANGUAGE_CHAIN = "en-BE,en;q=0.9,nl-BE;q=0.8,fr-BE;q=0.7";

let cached: { context: BrowserContext } | null = null;

export async function connect(): Promise<{ browser: Browser; context: BrowserContext }> {
  if (cached) {
    const browser = cached.context.browser();
    if (browser?.isConnected()) return { browser, context: cached.context };
    cached = null;
  }

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    // Prefer explicit binary path (Mac dev = Brave, Ubuntu prod = Chrome). Fall
    // back to channel:'chrome' which looks up Google Chrome from PATH.
    ...(CHROME_PATH ? { executablePath: CHROME_PATH } : { channel: "chrome" }),
    headless: HEADLESS,
    // viewport: null = use the actual OS window size instead of Playwright's
    // 1280x720 default. A 1280x720 viewport on a 2560x1440 display is itself
    // a bot tell.
    viewport: null,
    proxy: PROXY_SERVER ? { server: PROXY_SERVER } : undefined,
    locale: LOCALE,
    timezoneId: TIMEZONE,
    geolocation: { latitude: BRUSSELS_LAT, longitude: BRUSSELS_LON },
    permissions: ["geolocation"],
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=BraveRewards,BraveWallet,BraveAds,BraveTor",
    ],
  });

  // Override the single-locale Accept-Language patchright sets from `locale` with
  // a richer multi-locale preference chain. Belgian users typically have all
  // four locales configured in their OS, and a single `en-BE` is itself a soft
  // signal of a synthetic profile.
  await context.setExtraHTTPHeaders({ "Accept-Language": ACCEPT_LANGUAGE_CHAIN });

  cached = { context };
  return { browser: context.browser()!, context };
}

// Backwards compat for /health endpoint + smoke test. Patchright launches its
// own browser so reachability is always true once connect() succeeds. We
// attempt a lightweight connect to detect launch failures early.
export async function isReachable(): Promise<boolean> {
  try {
    await connect();
    return true;
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
