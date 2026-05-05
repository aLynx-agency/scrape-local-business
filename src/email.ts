import type { BrowserContext } from "playwright";

const PAGE_TIMEOUT_MS = 15_000;
const PROSPECT_TOTAL_TIMEOUT_MS = 50_000;
// Most agency sites inject their nav menu via JS after DOMContentLoaded.
// The old 300ms settle was too short — the <a href="/contact"> link wasn't in
// the DOM yet when we extracted. 1500ms catches the vast majority.
const POST_GOTO_SETTLE_MS = 1_500;
const MAX_DISCOVERED_LINK_FOLLOWS = 3;

const JUNK_LOCAL_PART = /^(?:noreply|no-reply|donotreply|do-not-reply|admin|postmaster|webmaster|root|test|wordpress|hello@example)/i;
const JUNK_DOMAIN = /@(?:example\.(?:com|org|net)|test\.com|sentry\.(?:io|wixpress\.com)|wixpress\.com|godaddy\.com)\b/i;
const PRIORITY_PREFIXES = ["info@", "contact@", "hello@", "office@", "kontakt@", "contacto@", "mail@"];

// Hardcoded fallback paths to probe when (a) the homepage had no emails AND
// (b) discovered link scan didn't find a contact-page link. Many sites have
// /contact in their sitemap but only expose it via a JS-only mobile menu or
// a footer that loads lazily — link discovery misses it but the path
// itself exists. Probed in priority order; we stop at the first hit.
const HARDCODED_CONTACT_PATHS = [
  "/contact",
  "/contact/",
  "/contacten",        // nl
  "/contacten/",
  "/contact-us",
  "/contact-us/",
  "/contactus",
  "/kontakt",          // de / pl
  "/contacto",         // es
  "/contacts",
  "/contattaci",       // it
  "/over-ons",         // nl "about us" — frequently has a contact block
  "/en/contact",
  "/nl/contact",
];

export async function findEmail(context: BrowserContext, url: string): Promise<string> {
  if (!url || !/^https?:\/\//i.test(url)) return "";
  if (/^https?:\/\/(?:www\.)?google\.[a-z.]+\/maps/i.test(url)) return "";

  const TIMED_OUT = "__timeout__";
  const result = await Promise.race([
    findEmailInner(context, url).catch((e) => {
      console.warn(`[email] threw for ${url}: ${(e as Error).message}`);
      return "";
    }),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve(TIMED_OUT), PROSPECT_TOTAL_TIMEOUT_MS),
    ),
  ]);
  if (result === TIMED_OUT) {
    console.warn(`[email] timed out after ${PROSPECT_TOTAL_TIMEOUT_MS}ms — ${url}`);
    return "";
  }
  return result;
}

async function findEmailInner(context: BrowserContext, url: string): Promise<string> {
  const t0 = Date.now();
  const tried = new Set<string>(); // dedupe across discovered + hardcoded paths

  // Strategy 1: homepage.
  const home = await visitAndExtract(context, url);
  tried.add(normalize(url));
  if (home.emails.length > 0) {
    const best = pickBest(home.emails);
    if (best) {
      console.log(`[email] ${Date.now() - t0}ms ${best} via=home  ${url}`);
      return best;
    }
  }

  // Strategy 2: same-origin contact-page links discovered on home, sorted by
  // priority (contact > reach-us > about > imprint).
  for (const link of home.contactLinks.slice(0, MAX_DISCOVERED_LINK_FOLLOWS)) {
    if (tried.has(normalize(link))) continue;
    tried.add(normalize(link));
    const sub = await visitAndExtract(context, link);
    if (sub.emails.length > 0) {
      const best = pickBest(sub.emails);
      if (best) {
        console.log(`[email] ${Date.now() - t0}ms ${best} via=link link=${link}  ${url}`);
        return best;
      }
    }
  }

  // Strategy 3: hardcoded path probes. Catches sites whose link discovery
  // missed because the nav is JS-only / hamburger / footer-injected.
  let baseUrl: URL;
  try {
    baseUrl = new URL(url);
  } catch {
    return "";
  }
  for (const path of HARDCODED_CONTACT_PATHS) {
    const probe = `${baseUrl.protocol}//${baseUrl.hostname}${path}`;
    if (tried.has(normalize(probe))) continue;
    tried.add(normalize(probe));
    const sub = await visitAndExtract(context, probe);
    if (sub.emails.length > 0) {
      const best = pickBest(sub.emails);
      if (best) {
        console.log(`[email] ${Date.now() - t0}ms ${best} via=probe path=${path}  ${url}`);
        return best;
      }
    }
  }

  console.log(`[email] ${Date.now() - t0}ms (none) tried=${tried.size}pages  ${url}`);
  return "";
}

function normalize(u: string): string {
  // Used to dedupe URLs across discovery + hardcoded probes. We don't care
  // about trailing slashes / case for dedupe purposes.
  return u.toLowerCase().replace(/\/+$/, "");
}

interface ExtractResult {
  emails: string[];
  contactLinks: string[];
}

async function visitAndExtract(context: BrowserContext, url: string): Promise<ExtractResult> {
  let page;
  try {
    page = await context.newPage();
    // Block heavy resource types — emails live in HTML, we don't need
    // images/fonts/css/media. Saves ~99% of proxy bandwidth per prospect.
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font" || t === "stylesheet") {
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    // Most agency sites inject their nav menu via JS after DOMContentLoaded.
    // Wait long enough for hydration so the contact-page <a> is in the DOM
    // when we read it.
    await page.waitForTimeout(POST_GOTO_SETTLE_MS);

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

        // 4. Same-origin contact-page links (for follow-up crawl), scored by
        // how likely the destination is to contain emails. /contact-style
        // pages get followed first; /about, /imprint last.
        const matches: { href: string; score: number }[] = [];
        document.querySelectorAll("a[href]").forEach((a) => {
          const href = (a as HTMLAnchorElement).href;
          const text = (a.textContent ?? "").trim();
          if (!href || !/^https?:\/\//i.test(href)) return;
          try {
            if (new URL(href).hostname !== baseHost) return;
          } catch {
            return;
          }
          const blob = `${href} ${text}`.toLowerCase();
          let score = -1;
          if (/contact|kontakt|contacto|contacten|contattaci/.test(blob)) score = 3;
          else if (/reach.?us|get.?in.?touch/.test(blob)) score = 2;
          else if (/over.?ons|nosotros/.test(blob)) score = 1;
          else if (/about|imprint|impressum|legal/.test(blob)) score = 0;
          if (score >= 0) matches.push({ href, score });
        });
        matches.sort((a, b) => b.score - a.score);
        const seen = new Set<string>();
        const contactLinks: string[] = [];
        for (const m of matches) {
          if (seen.has(m.href)) continue;
          seen.add(m.href);
          contactLinks.push(m.href);
          if (contactLinks.length >= 8) break;
        }

        return {
          emails: Array.from(emails),
          contactLinks,
        };
      }, baseHost),
      new Promise((resolve) => setTimeout(() => resolve({ emails: [], contactLinks: [] }), 6_000)),
    ])) as ExtractResult;

    return result;
  } catch {
    return { emails: [], contactLinks: [] };
  } finally {
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
    const settled = await Promise.allSettled(chunk.map((item) => findEmail(context, item.url)));
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      out[i + j] = r.status === "fulfilled" ? r.value : "";
      if (r.status === "rejected") {
        console.warn(`[email] rejected (unexpected) for ${chunk[j].url}: ${(r.reason as Error)?.message ?? r.reason}`);
      }
    }
  }
  return out;
}
