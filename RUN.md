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

You need **two terminals**: one for the browser (must stay open), one for the API.

### Terminal 1 — launch the browser
```bash
# Headed (visible window, recommended for dev)
npm run chrome

# OR headless (no window, required for prod / no-display servers)
HEADLESS=true npm run chrome
```
Leave this running. Closing the terminal closes Brave, which kills the API's connection.

### Terminal 2 — start the API
```bash
npm run start
```
You should see `API ready on :3000`. Keep this terminal open too.

### Terminal 3 — call the API
```bash
# Health check (Brave + API both up?)
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
# Stop the API
pkill -f "tsx.*src/server"

# Close the browser (also closes via the terminal where you ran npm run chrome)
pkill -f "Brave Browser"
```

## Troubleshooting

**`Browser CDP not reachable at http://127.0.0.1:9222`**
The browser isn't running. Run `npm run chrome` in another terminal first.

**Brave is up but the API still errors with `ECONNREFUSED`**
Make sure no other process is using port 9222: `lsof -i :9222`. Kill the conflicting process or change `CDP_PORT` in `.env`.

**Heavy CAPTCHA / blocks during pagination**
Google has flagged the profile. Two options:
```bash
# A — clear the profile and start fresh (loses warm cookies; first scrape may CAPTCHA)
pkill -f "Brave Browser"
rm -rf chrome-profile/
npm run chrome
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

# CDP smoke test (verifies Playwright can talk to the browser)
npm run smoke

# See open Brave tabs (helpful for debugging tab leaks)
curl -s http://127.0.0.1:9222/json | python3 -c "import json,sys; [print(t.get('type'),'|',t.get('url','')[:80]) for t in json.load(sys.stdin)]"

# Tail the latest CSV
ls -t data/*.csv | head -1 | xargs head -20
```

## Ubuntu prod notes
1. Install Chrome: `sudo apt install google-chrome-stable`
2. Set `CHROME_PATH=/usr/bin/google-chrome-stable` and `HEADLESS=true` in `.env`
3. Run `npm run chrome` under a process manager (systemd unit or pm2). Same for `npm run start`.
4. Open port 3000 if accessed from another machine, otherwise bind locally only.
