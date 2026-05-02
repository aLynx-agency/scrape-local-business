import type { BrowserContext } from "playwright";

const PAGE_TIMEOUT_MS = 8_000;
const PROSPECT_TOTAL_TIMEOUT_MS = 25_000;
const JUNK_LOCAL_PART = /^(?:noreply|no-reply|donotreply|do-not-reply|admin|postmaster|webmaster|root|test|wordpress|hello@example)/i;
const JUNK_DOMAIN = /@(?:example\.(?:com|org|net)|test\.com|sentry\.(?:io|wixpress\.com)|wixpress\.com|godaddy\.com)\b/i;
const PRIORITY_PREFIXES = ["info@", "contact@", "hello@", "office@", "kontakt@", "contacto@", "mail@"];

export async function findEmail(context: BrowserContext, url: string): Promise<string> {
  if (!url || !/^https?:\/\//i.test(url)) return "";
  // Prospects without a real website get a Google Maps URL fallback — skip them.
  if (/^https?:\/\/(?:www\.)?google\.[a-z.]+\/maps/i.test(url)) return "";

  // Hard ceiling per prospect — guarantees the chunk completes even if a site
  // misbehaves (slow network, hung script, page.evaluate stall).
  return await Promise.race([
    findEmailInner(context, url),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), PROSPECT_TOTAL_TIMEOUT_MS)),
  ]);
}

async function findEmailInner(context: BrowserContext, url: string): Promise<string> {
  const t0 = Date.now();
  const home = await visitAndExtract(context, url);
  let emails = home.emails;

  if (emails.length === 0 && home.contactLinks.length > 0) {
    for (const link of home.contactLinks.slice(0, 2)) {
      const sub = await visitAndExtract(context, link);
      if (sub.emails.length > 0) {
        emails = sub.emails;
        break;
      }
    }
  }

  const best = pickBest(emails);
  console.log(`[email] ${Date.now() - t0}ms ${best || "(none)"}  ${url}`);
  return best;
}

interface ExtractResult {
  emails: string[];
  contactLinks: string[];
}

async function visitAndExtract(context: BrowserContext, url: string): Promise<ExtractResult> {
  let page;
  try {
    page = await context.newPage();
    // Block heavy resource types — emails live in HTML, we don't need images/fonts/media.
    // Big speedup for sites with heavy hero images and dramatically reduces stall risk.
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font" || t === "stylesheet") {
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    // Tiny settle for sites that hydrate emails via JS (Cloudflare obfuscation, etc.)
    await page.waitForTimeout(300);

    const baseHost = new URL(url).hostname;
    const result = (await Promise.race([
      page.evaluate((baseHost: string) => {
      const emails = new Set<string>();

      // 1. mailto: links
      document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
        const href = (a as HTMLAnchorElement).href;
        const m = href.match(/^mailto:([^?]+)/i);
        if (m && m[1]) {
          try {
            emails.add(decodeURIComponent(m[1]).trim());
          } catch {
            emails.add(m[1].trim());
          }
        }
      });

      // 2. Cloudflare email obfuscation (data-cfemail hex string)
      document.querySelectorAll("[data-cfemail]").forEach((el) => {
        const enc = el.getAttribute("data-cfemail") ?? "";
        if (enc.length < 4) return;
        const r = parseInt(enc.substring(0, 2), 16);
        if (Number.isNaN(r)) return;
        let decoded = "";
        for (let n = 2; n < enc.length; n += 2) {
          const c = parseInt(enc.substring(n, n + 2), 16) ^ r;
          if (Number.isNaN(c)) return;
          decoded += String.fromCharCode(c);
        }
        if (decoded.includes("@")) emails.add(decoded);
      });

      // 3. Plain-text email regex over visible body text
      const bodyText = document.body ? document.body.innerText : "";
      const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(bodyText)) !== null) {
        emails.add(m[0]);
      }

      // 4. Same-origin contact-page links (for follow-up crawl)
      const contactLinks = new Set<string>();
      const linkRe = /(contact|kontakt|contacto|contacten|about|nosotros|over[\s-]?ons|imprint|impressum|legal)/i;
      document.querySelectorAll("a[href]").forEach((a) => {
        const href = (a as HTMLAnchorElement).href;
        const text = (a.textContent ?? "").trim();
        if (!href || !/^https?:\/\//i.test(href)) return;
        try {
          if (new URL(href).hostname !== baseHost) return;
        } catch {
          return;
        }
        if (linkRe.test(href) || linkRe.test(text)) contactLinks.add(href);
      });

      return {
        emails: Array.from(emails),
        contactLinks: Array.from(contactLinks).slice(0, 5),
      };
    }, baseHost),
      new Promise((resolve) => setTimeout(() => resolve({ emails: [], contactLinks: [] }), 6_000)),
    ])) as ExtractResult;

    return result;
  } catch {
    return { emails: [], contactLinks: [] };
  } finally {
    // Force-close: some sites use `beforeunload` to prompt "are you sure?", which
    // hangs the default close() forever. `runBeforeUnload: false` bypasses it.
    // The 3s timeout guards against any other hang path.
    if (page) await page.close({ runBeforeUnload: false }).catch(() => {});
  }
}

function isValidEmail(email: string): boolean {
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const [, domain] = parts;
  const tld = domain.split(".").pop() ?? "";
  if (!/^[a-zA-Z]{2,8}$/.test(tld)) return false;
  if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf)$/i.test(domain)) return false;
  return true;
}

function pickBest(emails: string[]): string {
  const cleaned = emails
    .map((e) => e.toLowerCase().trim())
    .filter(isValidEmail)
    .filter((e) => !JUNK_LOCAL_PART.test(e))
    .filter((e) => !JUNK_DOMAIN.test(e));
  if (cleaned.length === 0) return "";

  const unique = Array.from(new Set(cleaned));
  for (const prefix of PRIORITY_PREFIXES) {
    const found = unique.find((e) => e.startsWith(prefix));
    if (found) return found;
  }
  return unique[0];
}

export async function findEmailsConcurrent<T extends { url: string }>(
  context: BrowserContext,
  items: T[],
  concurrency = 5,
): Promise<string[]> {
  const out: string[] = new Array(items.length).fill("");
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const settled = await Promise.all(chunk.map((item) => findEmail(context, item.url).catch(() => "")));
    for (let j = 0; j < settled.length; j++) {
      out[i + j] = settled[j];
    }
  }
  return out;
}
