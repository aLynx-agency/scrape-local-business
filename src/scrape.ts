import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { closeOpenedPages, connect } from "./chrome.ts";
import { writeCsv } from "./csv.ts";
import { findEmailsConcurrent } from "./email.ts";
import { isBlockedDeep, solveIfBlocked } from "./captcha.ts";
import type { ScrapeResponse, SerpResult } from "./types.ts";

const SCREENSHOT_DIR = "screenshots";
const DATA_DIR = "data";
const VIEWPORT_WIDTH = 1366;
// Google Local Finder serves 10 results per page (was 20 in older layouts).
// `start` is a 0-based row offset, so page N's URL gets start = N * 10. With
// the wrong stride (20) we'd step over half of every page's results — visible
// in scrape logs as ~10 unique prospects per page instead of ~20, with
// every-other-rank gaps in the output.
const RESULTS_PER_PAGE = 10;

export async function scrape(query: string, maxPages = 5): Promise<ScrapeResponse> {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  const { context } = await connect();
  const page = await context.newPage();

  try {
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: 900 });

    await mkdir(SCREENSHOT_DIR, { recursive: true });
    await mkdir(DATA_DIR, { recursive: true });

    const results: SerpResult[] = [];
    const seenNames = new Set<string>();
    let screenshotPath = join(SCREENSHOT_DIR, `${id}.png`);
    let pagesScraped = 0;

    // Track consecutive failures (transient errors *or* "no cards" pages). One
    // bad page shouldn't kill the whole scrape — try the next page. But if
    // we hit several in a row, that's either end-of-results or a persistent
    // block, and we should stop rather than burn the rest of the budget.
    const MAX_CONSECUTIVE_FAILURES = 2;
    let consecutiveFailures = 0;

    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
      const start = pageNum * RESULTS_PER_PAGE;
      const url =
        `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=1&hl=en` +
        (start > 0 ? `&start=${start}` : "");
      console.log(`[scrape] page ${pageNum + 1}/${maxPages} — ${url}`);

      let pageOk = false;
      let pageHardBlock = false;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await dismissConsent(page);

        // Settle after navigation — a real user takes a moment to "read" the
        // page before clicking. Slower pacing trades latency for lower /sorry/.
        await page.waitForTimeout(1500 + Math.random() * 1500);

        // CAPTCHA / soft block check. `isBlockedDeep` catches both /sorry/
        // pages and the softer "unusual traffic" interstitial on /search?q=….
        if (await isBlockedDeep(page)) {
          const solved = await solveIfBlocked(page);
          if (!solved) {
            console.log(`[scrape] blocked at page ${pageNum + 1}, cannot solve — stopping pagination`);
            pageHardBlock = true;
          }
        }

        if (!pageHardBlock) {
          try {
            await page.waitForSelector("div.VkpGBb", { timeout: 10_000 });
          } catch {
            console.log(`[scrape] no cards on page ${pageNum + 1} — likely end of results or transient`);
            consecutiveFailures++;
            // fall through; pageOk stays false
          }

          if (await page.$("div.VkpGBb")) {
            const pageResults = await extractLocal(page);
            if (pageResults.length === 0) {
              console.log(`[scrape] zero usable results on page ${pageNum + 1}`);
              consecutiveFailures++;
            } else {
              let added = 0;
              for (const r of pageResults) {
                if (seenNames.has(r.name)) continue; // dedupe across pages
                seenNames.add(r.name);
                r.position = results.length + 1;
                results.push(r);
                added++;
              }
              console.log(`[scrape] page ${pageNum + 1} added ${added} new prospects (total ${results.length})`);
              pagesScraped++;
              pageOk = true;
              consecutiveFailures = 0;

              // Take screenshot only on page 1 — that's the outreach asset.
              if (pageNum === 0) {
                try {
                  await captureTop5Screenshot(page, screenshotPath);
                } catch (e) {
                  console.warn(`[scrape] screenshot failed: ${(e as Error).message} — continuing without it`);
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn(`[scrape] page ${pageNum + 1} threw: ${(e as Error).message} — skipping to next page`);
        consecutiveFailures++;
      }

      if (pageHardBlock) break;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log(`[scrape] ${consecutiveFailures} consecutive page failures — stopping pagination`);
        break;
      }

      // Inter-page wait — only when we're going to try another page. Use a
      // shorter delay after a failed page (we're retrying, not browsing).
      if (pageNum + 1 < maxPages) {
        const delay = pageOk ? 4000 + Math.random() * 4000 : 2000 + Math.random() * 1500;
        await page.waitForTimeout(delay);
      }
    }

    if (results.length === 0) {
      throw new Error("scrape returned zero results — likely blocked on first page");
    }
    console.log(`[scrape] pagination done: ${pagesScraped} pages, ${results.length} prospects`);

    await page.close();

    // Email crawl across the entire accumulated list. Concurrency 3 (down
    // from 5): slower but a meaningful reduction in proxy bandwidth peaks
    // and stall risk on slow agency sites.
    //
    // Resilience: per-prospect failures are already swallowed inside
    // findEmailsConcurrent (.catch(() => "") on each chunk member), so one
    // dead site can't break the rest. Catastrophic failures (e.g. CDP drops
    // mid-crawl) are wrapped here so the SERP results we already have still
    // get returned, just without emails.
    try {
      const { context: ctx } = await connect();
      const emails = await findEmailsConcurrent(ctx, results, 3);
      for (let i = 0; i < results.length; i++) results[i].email = emails[i];
    } catch (e) {
      console.warn(`[scrape] email crawl failed wholesale: ${(e as Error).message} — returning prospects without emails`);
    }

    const csvPath = join(DATA_DIR, `${id}.csv`);
    await writeCsv(csvPath, results);

    return {
      id,
      query,
      timestamp: new Date().toISOString(),
      screenshotPath,
      csvPath,
      results,
    };
  } finally {
    if (!page.isClosed()) await page.close({ runBeforeUnload: false }).catch(() => {});
    // Belt-and-suspenders: close any prospect tabs that didn't unwind their finally
    // block cleanly. Brave should be at zero non-blank tabs after every request.
    await closeOpenedPages();
  }
}

async function captureTop5Screenshot(page: Page, screenshotPath: string): Promise<void> {
  // Hide sponsored cards so visual rank matches data rank.
  await page.evaluate(() => {
    document.querySelectorAll("div.VkpGBb").forEach((card) => {
      const a = card.querySelector("a.L48Cpd") as HTMLAnchorElement | null;
      const href = a?.href ?? "";
      if (/\/aclk\?|googleadservices/i.test(href)) {
        (card as HTMLElement).style.display = "none";
      }
    });
  });

  // Force lazy-loaded ratings/snippets to render before measuring layout.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  // Crop top-of-page → start of 6th visible card (so top 5 are fully shown).
  const visibleCards = await page.$$("div.VkpGBb:not([style*='display: none'])");
  const cutoffCard = visibleCards[5];
  let clip: { x: number; y: number; width: number; height: number } | undefined;
  if (cutoffCard) {
    const box = await cutoffCard.boundingBox();
    if (box) clip = { x: 0, y: 0, width: VIEWPORT_WIDTH, height: Math.ceil(box.y - 4) };
  } else if (visibleCards.length > 0) {
    const lastBox = await visibleCards[visibleCards.length - 1].boundingBox();
    if (lastBox) clip = { x: 0, y: 0, width: VIEWPORT_WIDTH, height: Math.ceil(lastBox.y + lastBox.height + 80) };
  }
  // `fullPage: true` is required alongside `clip`: without it, Playwright caps
  // the screenshot at viewport height (900px), silently truncating the bottom.
  await page.screenshot(clip ? { path: screenshotPath, fullPage: true, clip } : { path: screenshotPath, fullPage: true });
}

async function dismissConsent(page: Page): Promise<void> {
  // The "Before you continue to Google" overlay (and the older EU consent
  // dialog) is injected lazily after navigation. The previous version of this
  // function returned immediately if no button was present yet, so we'd often
  // screenshot the modal sitting on top of results. Poll for up to 4s for an
  // Accept button across common locales, then verify dismissal.
  //
  // We prefer "Accept all" over "Reject all" so the screenshot looks like a
  // normal Google search session — Reject sometimes triggers a "limited
  // results" mode that makes the screenshot less useful for outreach.
  const acceptSelectors = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Alles accepteren")', // nl
    'button:has-text("Alles akzeptieren")', // de
    'button:has-text("Tout accepter")', // fr
    'button:has-text("Aceptar todo")', // es
    'button:has-text("Accetta tutto")', // it
    'button:has-text("I agree")',
    "#L2AGLb",
    '[aria-label="Accept all" i]',
  ];

  const start = Date.now();
  let clicked = false;
  while (!clicked && Date.now() - start < 4000) {
    for (const sel of acceptSelectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0) {
        try {
          await btn.click({ timeout: 2000 });
          clicked = true;
          break;
        } catch {
          // not clickable yet, try next
        }
      }
    }
    if (!clicked) await page.waitForTimeout(200);
  }

  if (!clicked) return; // no dialog appeared — fine, persistent profile probably already accepted

  // Wait for the modal to actually go away. Reload-style consent reloads the
  // page; overlay-style fades. Either way, give it a beat to settle so the
  // subsequent screenshot doesn't capture the dialog mid-fade.
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function extractLocal(page: Page): Promise<SerpResult[]> {
  // Local Finder DOM (May 2026):
  // - Each card is `div.VkpGBb` containing:
  //     - `div.dbg0pd[role="heading"]` → business name
  //     - `a.L48Cpd` → "Website" link (external URL we want)
  //     - `a.VDgVie` → "Directions" link (Google Maps URL — fallback only)
  // - Sponsored cards mix in at the top with the same VkpGBb wrapper, but their
  //   website href routes through google.com/aclk or googleadservices.com.
  //   Filter by URL pattern.
  const raw = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll("div.VkpGBb"));
    const out: { name: string; url: string; phone: string; snippet: string }[] = [];
    const seen = new Set<string>();
    for (const card of cards) {
      const nameEl = card.querySelector("div.dbg0pd");
      const name = (nameEl?.textContent ?? "").trim();
      if (!name || seen.has(name)) continue;

      // Skip cards without an exposed Website button. These are listings whose
      // owner never added a website to their Google Business profile — clicking
      // through to the side panel won't reveal one either, so they're useless
      // for outreach (no site to email, no Lighthouse target).
      const websiteEl = card.querySelector("a.L48Cpd") as HTMLAnchorElement | null;
      if (!websiteEl?.href) continue;
      const url = websiteEl.href;

      // Sponsored detection: URL pattern catches most ads. Text-based fallback
      // catches the rare case where the ad has a real-looking website href.
      const isAd =
        /\/aclk\?|googleadservices\.com|\/url\?.*adurl=/i.test(url) ||
        /\b(?:gesponsord|sponsored|gesponsert|annonce)\b/i.test((card.textContent ?? "").slice(0, 30)) ||
        /(mijn advertentiecentrum|my ad cent|mon centre publicitaire)/i.test(name);
      if (isAd) continue;

      seen.add(name);
      const detailsEl = card.querySelector("div.rllt__details");
      const detailsText = (detailsEl?.textContent ?? "").replace(/\s+/g, " ").trim();

      // Phone: try international (`+32 487 65 99 45`), then Belgian local
      // (`02 706 41 41` / `0487 65 99 45`). Negative-lookahead `(?!\d)` at the
      // end prevents truncation when the phone runs into trailing text without
      // a separator (Google's snippet text often does this).
      const intlMatch = detailsText.match(/\+\d{1,3}[\s.\-]?\d[\d\s.\-]{5,15}\d(?!\d)/);
      const localMatch = !intlMatch ? detailsText.match(/\b0\d[\d\s.\-]{6,12}\d(?!\d)/) : null;
      const phone = (intlMatch?.[0] ?? localMatch?.[0] ?? "").replace(/\s+/g, " ").trim();

      const snippet = detailsText.replace(name, "").trim().slice(0, 240);
      out.push({ name, url, phone, snippet });
    }
    return out;
  });

  return raw.map((r, i) => ({
    position: i + 1,
    name: r.name,
    url: r.url,
    email: "",
    phone: r.phone,
    snippet: r.snippet,
  }));
}
