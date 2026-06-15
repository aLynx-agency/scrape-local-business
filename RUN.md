# Running the SERP Scraper API

## Prerequisites
- Node.js 20+ (`node --version`)
- A Chromium-based browser. On macOS dev, Brave at `/Applications/Brave Browser.app/`. On Ubuntu prod, `google-chrome-stable` (or `brave-browser`).

## First-time setup

```bash
# Install dependencies
npm install

# Copy env template and fill in your 2captcha key
cp .env.example .env
# Then edit .env and set TWOCAPTCHA_API_KEY=<your key>
```

## Daily run

Patchright launches its own Chrome via `launchPersistentContext`, so the
old two-terminal flow (manual `npm run chrome` then `npm run start`) is gone.
One terminal for the API is enough.

### Terminal 1 — start the API
```bash
# Headed (visible window, recommended for dev)
npm run start

# OR headless (no window, required for prod / no-display servers)
HEADLESS=true npm run start
```
You should see `API ready on :3000`. The first scrape request triggers
patchright to launch Chrome using `CHROME_PATH` (or `channel: 'chrome'` if
unset) with a persistent profile at `USER_DATA_DIR` (default `./chrome-profile`).

### Optional — manual Chrome for debugging
If you want to poke at the same profile in a real window between scrapes,
`scripts/launch-chrome.sh` (the old CDP-attach path) is still around:
```bash
npm run chrome   # opens a headed Chrome on the same user-data-dir
```
This is **not** required for the API; it's purely for inspecting cookies,
saved consent, etc.

### Terminal 2 — call the API
```bash
# Health check (API up + patchright able to launch?)
curl http://localhost:3000/health
# → {"ok":true,"chromeConnected":true}

# Scrape Local Finder for a query (default 5 pages = 100 prospects)
curl -X POST http://localhost:3000/scrape \
  -H 'Content-Type: application/json' \
  -d '{"query":"dentist in Brussels","maxPages":5}'

# Lighthouse audit for a single URL
curl -X POST http://localhost:3000/lighthouse \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.be/"}'

# Lighthouse with full LHR (~1MB) inlined in response
curl -X POST http://localhost:3000/lighthouse \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.be/","full":true}'
```

## Output files
Each `/scrape` call writes:
- `screenshots/<id>.png` — top-5 cropped Local Finder screenshot
- `data/<id>.csv` — `position, name, url, email, phone, snippet`

Each `/lighthouse` call writes:
- `lighthouse/<id>.json` — full Lighthouse Result (~1MB)

The response JSON includes `screenshotPath`, `csvPath`, `reportPath` so n8n / downstream tools can read the files.

## Stopping

```bash
# Stop the API (patchright closes the browser as part of shutdown)
pkill -f "tsx.*src/server"

# If the browser hangs around for any reason:
pkill -f "Google Chrome"   # or "Brave Browser" depending on CHROME_PATH
```

## Troubleshooting

**`Executable doesn't exist at <path>` or `browserType.launch: ...`**
Patchright can't find a Chrome binary. Either:
- Set `CHROME_PATH` in `.env` to your installed browser, OR
- Install Google Chrome (`brew install --cask google-chrome` on Mac, `sudo apt install google-chrome-stable` on Ubuntu) — patchright's default `channel: 'chrome'` will pick it up.

**Heavy CAPTCHA / blocks during pagination**
Google has flagged the profile. Options:
```bash
# A — clear the profile and start fresh (loses warm cookies; first scrape may CAPTCHA)
pkill -f "Google Chrome"   # or "Brave Browser" depending on CHROME_PATH
rm -rf chrome-profile/
npm run start              # patchright re-creates the profile on next request
```
or wait 24–48 hours for Google's flag to expire.

**`/scrape` returns 500 with "scrape returned zero results"**
Page 1 was blocked and 2captcha couldn't solve it. Verify `TWOCAPTCHA_API_KEY` is set in `.env` and that you have credit on the 2captcha account.

**Lighthouse takes 60+ seconds**
Normal — Lighthouse runs throttled network simulations. Big sites can take 90s+. The audit summary returns when it's done.

## Useful one-liners

```bash
# Type-check the code
npm run typecheck

# Smoke test (verifies patchright can launch + reach example.com)
npm run smoke

# Tail the latest CSV
ls -t data/*.csv | head -1 | xargs head -20
```

## Ubuntu prod notes
1. Install Chrome: `sudo apt install google-chrome-stable`
2. Set `CHROME_PATH=/usr/bin/google-chrome-stable` and `HEADLESS=true` in `.env`
3. Run `npm run chrome` under a process manager (systemd unit or pm2). Same for `npm run start`.
4. Open port 3000 if accessed from another machine, otherwise bind locally only.
