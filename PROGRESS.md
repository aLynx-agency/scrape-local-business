# SERP Scraper API — Progress Log

## Goal
HTTP API: query in (e.g. "dentist in Brussels") → CSV of businesses + full-page screenshot + JSON response. Step 1 of n8n outreach pipeline. Email crawling, Lighthouse, Gemini are later steps and **not** part of this API.

## Decisions
- **Stack**: Node.js + TypeScript + Fastify + Playwright (over CDP)
- **Browser**: Real Chrome launched separately with `--remote-debugging-port=9222` and a dedicated `user-data-dir`. Playwright connects via `chromium.connectOverCDP()`.
- **Results**: Scrape both Map Pack and Organic, labeled by `type`. CSV stores both. No "positions 4-8" filter inside the scraper — n8n does that.
- **Output**: response JSON + CSV file + PNG file saved to disk under `data/` and `screenshots/`. Paths returned in response.
- **Deploy**: dev on macOS, prod on Ubuntu. Chrome binary path via `CHROME_PATH` env var.

## API shape
```
POST /scrape
body: { "query": "dentist in Brussels", "maxPages": 5 }
returns: {
  id, query, timestamp,
  screenshotPath,    // PNG of Google Local Finder (full ranked list, ~20 businesses)
  csvPath,
  results: [{ position, name, url, email, phone, snippet }]
}

POST /lighthouse
body: { "url": "https://example.be/", "full": false }
returns: {
  id, url, reportPath,
  summary: {
    finalUrl, fetchTime,
    scores: { performance, accessibility, bestPractices, seo },  // 0..1
    metrics: { fcpMs, lcpMs, tbtMs, cls, speedIndexMs }
  },
  // lhr (full Lighthouse Result, ~1MB JSON) only if `full: true`
}

GET /health → { ok: true, chromeConnected: boolean }
```

Results come from Google's Local Finder (`?udm=1`) — exclusively local businesses, the only outreach prospect pool. Sponsored cards are stripped (detected by `aclk?` / `googleadservices` URL). Position numbering starts at 1 *after* sponsored exclusion, so n8n's "skip top 3, target 4-8" filter maps cleanly to actual organic local rankings.

`maxPages` (default 5, max 10) controls pagination — each page = 20 prospects. Pages 2+ append directly via `&start=20`, `&start=40`, etc. Polite jittered delay (~1s) between page loads. Deduplication by business name across pages. If Google returns a CAPTCHA (URL → `/sorry/`), the server tries to solve it via 2captcha when `TWOCAPTCHA_API_KEY` is set; otherwise pagination stops at the block and returns whatever was collected.

`email` is best-effort: visit prospect's homepage, look for `mailto:` links + Cloudflare-obfuscated `data-cfemail` + plain-text email regex. If none found, follow up to 2 same-origin "contact"/"about"-flavored sub-page links and try again. Filter junk (`noreply@`, system emails). One email returned, prioritized by prefix (`info@` > `contact@` > `hello@` > etc). Empty string if nothing found.

## Milestones
- [x] M1 — Project scaffold (package.json, tsconfig, deps installed)
- [x] M2 — Chrome launch script (Mac, Brave) + CDP connect smoke test
- [x] M3 — Scrape organic results for a query (name/url/snippet/position)
- [x] M4 — Scrape SERP Map Pack — superseded by M4b
- [x] M4b — Two-pass scrape: SERP organic + Local Finder — superseded by M4c
- [x] M4c — Single-pass: Local Finder only. Organic results dropped (not outreach prospects). One screenshot. ~1.5s.
- [x] M4d — Email crawl per prospect: mailto + cfemail + regex, sub-page follow, concurrency 5, hard 25s per-prospect timeout. ~30-45s for 20 prospects, ~65% hit rate.
- [x] M4e — `/lighthouse` endpoint: runs Lighthouse over CDP against existing Brave, saves full LHR, returns compact summary (scores + 5 core vitals).
- [x] M4f — Phone field added to results (regex on `div.rllt__details`); sponsored cards hidden via `display:none` before screenshot; screenshot cropped to top-5 visible local pack cards. Now: every prospect has email-or-phone (100% reachability).
- [x] M4g — Pagination via `&start=N` parameter, default 5 pages = 100 prospects. Deduplication by business name across pages. Polite jittered delay between pages. CAPTCHA detection (URL contains `/sorry/`) with 2captcha integration to solve via reCAPTCHA v2 token injection. Screenshot taken on page 1 only (the outreach asset).
- [x] M4h — Hardening: longer human-like waits (2-4.5s between pages, 600-1100ms post-load settle), force-close on `beforeunload` so prospect tabs can't hang the crawler, defensive `closeOpenedPages()` runs after every `/scrape` and `/lighthouse` to guarantee zero leftover tabs in Brave between requests. Headless mode supported via `HEADLESS=true` env var on the launch script (uses Chrome's `--headless=new`).
- [x] M5 — Full-page screenshot saved (Local Finder only)
- [x] M6 — CSV writer to `data/<id>.csv`
- [x] M7 — Wire `/scrape` and `/health` endpoints, return JSON
- [ ] M8 — Validate on Ubuntu prod (parameterized via `CHROME_PATH`, untested there)
- [ ] M9 — README / deploy notes (only when prod-ready)

## Selectors (May 2026 — likely to drift, recheck if results disappear)
- **Organic** (on SERP): `#search a:has(h3)` (each anchor with an `<h3>` inside the search container).
  Snippet probed via `[data-sncf="1"]`, `[data-snc]`, `div.VwiC3b`, `span[role="text"]` in priority order on the closest `[data-hveid]` ancestor.
- **Local card** (Local Finder `udm=1` and SERP Map Pack — same DOM): `div.VkpGBb` wraps each card. Sponsored cards on SERP use `vwVdIc/rllt__link` (excluded by selector). Sponsored cards on Local Finder share the VkpGBb wrapper but route URLs through `aclk?` / `googleadservices` (excluded by URL pattern).
  - Name: `div.dbg0pd[role="heading"]` inside the card
  - Website: `a.L48Cpd` (the external URL we want)
  - Directions (fallback only): `a.VDgVie` (Google Maps URL)
  - Snippet: `div.rllt__details` text minus the name
- **Section anchor for diagnostics on SERP**: `div[role="heading"][aria-label^="Places"]`
- **URL transition**: Google now rewrites `?tbm=lcl` → `?udm=1`. We send `udm=1` directly.

## Known limitations
- ~~Local Finder caps at ~20 businesses per page~~ — fixed in M4g. Pagination via `&start=N` works, default 5 pages = 100 prospects. Beyond ~5 pages results thin out anyway (Google ranks local pack 1-100 with diminishing relevance).
- ~~Local Finder screenshot still includes the sponsored card visually~~ — fixed in M4f: sponsored cards are now hidden via inline `display:none` before screenshotting, so visual rank matches data rank.
- Organic snippet sometimes contains "Read more" or breadcrumb fragments — Google renders these inconsistently. Treat snippet as best-effort context, not authoritative.
- One observed quirk: Google occasionally bolds a query-matching token in a business name, which `textContent` concatenates into oddly-spaced names ("Charlotte" → "Chismile" in one run). Faithful to what Google rendered.
- Email hit rate ~65%. Misses are sites where email is gated behind a contact form (no `mailto:`) or buried >2 clicks deep. Could improve by clicking accordion/tab elements that hide contact info, or by following deeper navigation — both add latency and brittleness.
- Lighthouse over Brave inflates performance scores because Brave Shields strips ads/trackers before the audit. For accurate prod scores, run with `CHROME_PATH=/usr/bin/google-chrome-stable` on Ubuntu.
- `/scrape` and `/lighthouse` share the same Brave instance via CDP. Concurrent calls will fight over tabs. Single-user dev API for now; add a queue if scaling.

## Open questions / risks
- Google EU consent screen — handled by best-effort dismiss on first run; persistent user-data-dir means we only do it once. Not yet seen on this profile.
- Rate limiting / CAPTCHA — real Brave + persistent profile reduces risk but doesn't eliminate it. Add throttling/retry on prod once we see scale.
- Selector drift — Google's classnames (`VkpGBb`, `dbg0pd`, `L48Cpd`) are autogenerated and rotate. When they change, run a quick DOM diagnostic to find the new ones (process documented in this file's selectors section).

## Log
### 2026-05-03 — kickoff + M1–M7 done
- Empty repo → working API in one sitting. Stack: Node 20 + TS + Fastify 5 + Playwright (over CDP) + Brave.
- Brave at `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`; launch script `scripts/launch-chrome.sh` uses `CHROME_PATH` env var with sane macOS / Ubuntu defaults.
- **tsx + Playwright gotcha**: tsx wraps named functions/arrows with `__name(fn, "name")` calls for stack traces. When that compiled code runs inside `page.evaluate`, the browser has no `__name` and throws `ReferenceError`. Fix in `src/chrome.ts`: shim it via `context.addInitScript({ content: "globalThis.__name = globalThis.__name || function(fn){return fn;};" })` once per context.
- **End-to-end test (single-pass)**: `POST /scrape {"query":"dentist in Brussels"}` → 200 in ~1.7s. 14 results (3 Map Pack + 11 organic), screenshot 777 KB, CSV 2.9 KB.
- Iterated Map Pack selector twice before landing on `div.VkpGBb` as the canonical card root. Earlier heuristics matched the section but couldn't reach the website URL.

### 2026-05-03 — M4h: hardening (waits, tab cleanup, headless)
- **Bumped delays.** Between pages: 800-1400ms → **2000-4500ms**. Added a 600-1100ms post-navigation settle before extracting. Total ~3-6s per page transition — much more human-like.
- **Tab leak found and fixed.** After previous test runs, 2 prospect-site tabs were lingering in Brave because their sites had `beforeunload` handlers that hung the default `page.close()`. Fix: pass `runBeforeUnload: false` everywhere we close pages — bypasses the prompt and force-closes.
- **Defensive end-of-request cleanup.** New `closeOpenedPages()` in `chrome.ts` walks `context.pages()` and force-closes any non-blank/non-chrome:// page. Called from `finally` blocks of both `/scrape` and `/lighthouse`. Verified after a 2-page test: 0 leftover page tabs (was 4 before).
- **Headless mode.** `HEADLESS=true npm run chrome` launches Brave with `--headless=new --disable-gpu`. Tested: same 40-prospect scrape worked identically, screenshot pixel-equivalent to headed. Note: the User-Agent identifies as `HeadlessChrome` which Google can fingerprint; Google didn't block us in our test (likely thanks to the persistent profile/cookies), but on prod we may want to override `--user-agent=` to a plain Chrome string. Defer until we see actual blocking.
- **Browser process lifecycle (intentional choice).** Brave runs as a separate process; the API attaches via CDP and never kills it. This costs ~3-5s startup per request to relaunch — not worth it. Persistent process keeps cookies/consent state warm and reduces CAPTCHA risk. Tabs are still always cleaned up between requests.

### 2026-05-03 — M4g: pagination + 2captcha
- Implemented Local Finder pagination via `&start=N` URL param (no "Next" button clicking — direct URL is more stable). Default `maxPages=5` (up to 10 if requested).
- Each page navigation polls for `div.VkpGBb` (10s timeout). If selector misses → assume end of results, stop. If URL hits `/sorry/` → CAPTCHA path.
- 2captcha integration in `src/captcha.ts`: detect block, find reCAPTCHA `data-sitekey`, submit to `2captcha.com/in.php`, poll for solution token, inject into `g-recaptcha-response` textarea, submit form. Stops pagination if no API key set or solving fails.
- API key stored in `.env` (gitignored). Server scripts use `tsx --env-file=.env` to load it. `.env.example` documents the variable.
- Cross-page deduplication by business name (Google occasionally repeats listings across page boundaries).
- Polite jittered delay (800-1400ms) between page loads to reduce bot signal.
- **Tested**: "plumber in Antwerp" with `maxPages=5` → 100 prospects, 59 emails (59%), 98 phones (98%), 99/100 reachable (email OR phone), 0 CAPTCHAs triggered, 106s total. All 5 pages succeeded without intervention.

### 2026-05-03 — M4f: phone field + top-5 cropped screenshot
- User feedback: ~35% of sites have only contact forms (no email). Added `phone` field — extracted from `div.rllt__details` text via international phone regex (`+\d{1,3}[\s.-]?\d[\d\s.-]{5,15}\d`). Result: 100% phone coverage in test, 100% reachability (email OR phone).
- New outreach pitch is "you're nowhere visible" rather than per-position. Single shared image per query, sent to all prospects from that query — top 5 cropped Local Finder screenshot.
- Sponsored card hidden via JS `display:none` before screenshot, so visual rank now matches data rank.
- **Two crop bugs found and fixed**:
  1. Initial crop cut card #5 mid-content. Cause: card heights underreport via `boundingBox` because Google lazy-loads ratings/review snippets after initial layout. Fix: scroll-to-bottom-then-back trigger forces all lazy content to render before measuring.
  2. Even after fixing #1, the screenshot was clamped to viewport height (900px) when our clip asked for 991px. Cause: Playwright's `clip` is bounded by viewport unless `fullPage: true` is also set. Fix: pass both `fullPage: true` and `clip` together. Cost: +2-3s per screenshot (Playwright scrolls the whole page first).

### 2026-05-03 — M4d: email crawl + M4e: lighthouse endpoint
- **Email crawl wired into /scrape.** New module `src/email.ts`. For each prospect: visit homepage with image/font/css/media requests blocked (massive speedup), extract mailto links + `data-cfemail` (Cloudflare hex-XOR decoded) + plain-text email regex, follow up to 2 same-origin contact-flavored sub-pages if none found. Pick best email by prefix priority (info@ > contact@ > hello@ > office@ > kontakt@ > mail@). Filter junk locals (noreply, postmaster, etc) and junk domains (example.com, sentry.io, wixpress).
- **First implementation hung indefinitely** — page.evaluate had no timeout. Fix: wrapped both `page.evaluate` (6s) and the entire per-prospect `findEmail` (25s) in `Promise.race` against a setTimeout. Concurrency 5, total ~30-45s for 20 prospects.
- **Tested**: "plumber in Antwerp" → 13/20 emails found in 42s. Hit rate ~65%; misses were sites where the email isn't on the homepage AND isn't on /contact (could improve by following more sub-pages, but diminishing returns).
- **Lighthouse endpoint** uses the `lighthouse` npm package and our existing Brave on the CDP port. Returns 4 category scores + 5 core web vitals as a compact summary, saves the full LHR (~1MB) to disk and returns the path. Optional `full: true` flag inlines the full LHR in the response.
- **Tested**: lighthouse on khbabez.be (a real prospect) → 11s, scores returned cleanly. Performance 0.61, LCP 9.3s — concrete outreach pitch material.
- **Caveat documented**: Brave Shields strips ads/trackers before measurement, inflating perf scores vs real-Chrome users. For accurate prod scores, point `CHROME_PATH` at google-chrome on Ubuntu.

### 2026-05-03 — M4c: simplified to Local Finder only
- User feedback: confused by mixed `local` + `organic` rows in CSV (counted "12 instead of 20" — was looking at the organic section). Also wanted only one screenshot.
- Removed: SERP scrape pass, organic results, `type` field, second screenshot. CSV is now 4 columns (`position, name, url, snippet`), 20 rows of pure outreach prospects.
- Trade-off: organic results gone. They were mostly noise anyway (directories, salary sites, blog posts) — not outreach targets. Easy to add back as a separate endpoint if needed.
- Speed went from 2.8s → 1.5s.

### 2026-05-03 — M4b: two-pass scrape for 20+ local businesses
- User goal: maximize outreach pool. Single SERP only yielded 3 Map Pack results. Switched to two-pass scrape.
- Pass 2 navigates to `?udm=1` (Google's Local Finder). Confirmed Google rewrites `?tbm=lcl` → `?udm=1` automatically — we send `udm=1` directly.
- Same `VkpGBb` / `dbg0pd` / `L48Cpd` selectors work on the Local Finder page — extractor is unified into one `extractLocal` function, called only on the Local Finder.
- Sponsored card filter on Local Finder: detect `google.com/aclk?` or `googleadservices.com` in the website URL (different from SERP where the wrapper class differs).
- Type rename: `map_pack` → `local` to match what it actually is now.
- Response shape: `screenshotPath` → `serpScreenshotPath` + `localScreenshotPath`.
- **End-to-end test (two-pass)**: 200 in ~2.8s. **31 results (20 local + 11 organic)** — 7x more outreach targets. Local Finder screenshot 503 KB, SERP screenshot 597 KB, CSV ~5 KB.
