# Ubuntu Server Setup

End-to-end deployment guide for running the SERP scraper API on a fresh Ubuntu server (22.04 / 24.04 LTS). The browser runs **headless** here — there is no display.

## 0. Assumptions
- A non-root sudo user (call it `deploy`). All commands below run as that user unless prefixed with `sudo`.
- The server has outbound internet access (Google, 2captcha, target sites).
- You will reach the API from your laptop / n8n via SSH tunnel or a private network. **Do not** expose port 3000 to the public internet without auth in front of it.

## 1. System packages

```bash
sudo apt update
sudo apt install -y curl git ca-certificates ufw

# Chrome dependencies (fonts + GTK + graphics libs that headless still needs)
sudo apt install -y \
  fonts-liberation libasound2t64 libatk-bridge2.0-0 libatk1.0-0 \
  libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
  libnspr4 libnss3 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 \
  libxrandr2 xdg-utils
```

## 2. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # v20.x
npm --version
```

## 3. Install Google Chrome (stable)

```bash
wget -qO - https://dl.google.com/linux/linux_signing_key.pub \
  | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
  | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update
sudo apt install -y google-chrome-stable
google-chrome-stable --version   # confirms install
```

## 4. Clone and install the app

```bash
cd /opt
sudo mkdir -p serp-api && sudo chown "$USER:$USER" serp-api
git clone <your-repo-url> serp-api
cd serp-api
npm ci    # uses package-lock.json, faster + reproducible
```

If you don't have a git remote, `scp -r` the project folder up to `/opt/serp-api` instead.

## 5. Configure environment

```bash
cd /opt/serp-api
cp .env.example .env
nano .env
```

Set at minimum:

```env
TWOCAPTCHA_API_KEY=<your key>
CHROME_PATH=/usr/bin/google-chrome-stable
HEADLESS=true
CDP_PORT=9222
PORT=3000
```

Optional — outbound proxy. **Strongly recommended on cloud hosting** (AWS, GCP, DO, Hetzner, OVH, etc.). Datacenter IPs are pre-flagged by Google's bot detection: even a 2captcha-solved token gets rejected because the IP itself triggers a second-stage block. A residential proxy fixes this.

```env
# No-auth proxy (works out of the box)
PROXY_SERVER=http://proxy.example.com:8080
# or socks5://proxy.example.com:1080
```

Auth proxies (`user:pass@host:port`) need extra wiring at the Playwright level — Chrome strips inline credentials from `--proxy-server`. We ship `scripts/proxy-relay.mjs` for this: it handles upstream auth and exposes a no-auth localhost endpoint Chrome can use. Set:

```env
UPSTREAM_PROXY=http://user:pass@gw.your-provider.com:port
RELAY_PORT=8888
PROXY_SERVER=http://127.0.0.1:8888
```

**Sticky sessions are required, not optional.** Residential proxies rotate exit IPs per-connection by default. Google binds CAPTCHA challenges to the originating IP, so a token submitted from a different exit gets rejected with `IP address: X ≠ Y` on the /sorry/ page — even though both IPs are residential. The relay solves this by injecting a session tag into the proxy username so every request in one scrape uses the same exit.

```env
# Default — works for DataImpulse. Other providers vary:
#   IPRoyal:    -country-be-session-{id}-lifetime-30
#   Bright Data: -session-{id}
#   Oxylabs:    -session-{id}-sessTime-30
# Check your provider's "sticky session" docs.
STICKY_SESSION_FORMAT=__session.{id}

# Optional — auto-rotate the sticky session every N minutes (0 = never;
# new IP only on relay restart). Useful for spreading load over time.
SESSION_ROTATE_MINUTES=0
```

Lock the file down (it has a paid API key in it):

```bash
chmod 600 .env
```

## 6. Smoke test (manual)

Open two SSH sessions to the server.

**Session 1 — launch headless Chrome:**
```bash
cd /opt/serp-api
HEADLESS=true npm run chrome
```
Expect: `Launching: /usr/bin/google-chrome-stable`, then it sits there.

**Session 2 — start the API + hit it:**
```bash
cd /opt/serp-api
npm run start
# in a third terminal, or background the above and curl from the same one:
curl http://127.0.0.1:3000/health
# → {"ok":true,"chromeConnected":true}

curl -X POST http://127.0.0.1:3000/scrape \
  -H 'Content-Type: application/json' \
  -d '{"query":"dentist in Brussels","maxPages":1}'
```

If the health check returns `chromeConnected:true` and `/scrape` returns prospects, the runtime is good. Stop both processes (`Ctrl-C`) and move to systemd.

## 7. Run under systemd (production)

Two units: `serp-chrome.service` (the headless browser) and `serp-api.service` (the Node server, which depends on Chrome being up).

### 7a. Chrome unit
```bash
sudo nano /etc/systemd/system/serp-chrome.service
```
```ini
[Unit]
Description=Headless Chrome (CDP) for SERP scraper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/serp-api
Environment=HEADLESS=true
Environment=CHROME_PATH=/usr/bin/google-chrome-stable
ExecStart=/usr/bin/bash scripts/launch-chrome.sh
Restart=on-failure
RestartSec=5
# Chrome can chew memory on large sites — cap to keep one bad scrape from
# OOM-killing the whole box. Adjust if you hit it.
MemoryMax=2G

[Install]
WantedBy=multi-user.target
```

### 7b. API unit
```bash
sudo nano /etc/systemd/system/serp-api.service
```
```ini
[Unit]
Description=SERP scraper API (Fastify)
After=serp-chrome.service
Requires=serp-chrome.service

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/serp-api
EnvironmentFile=/opt/serp-api/.env
ExecStart=/usr/bin/npm run start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Replace `User=deploy` with the actual username (`whoami` on the server).

### 7c. Enable and start
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now serp-chrome.service
sudo systemctl enable --now serp-api.service

# Check both are running
systemctl status serp-chrome.service
systemctl status serp-api.service

# Tail logs
journalctl -u serp-api -f
journalctl -u serp-chrome -f
```

## 8. Firewall

Keep port 3000 closed to the public internet. Either bind locally only or use ufw:

```bash
sudo ufw allow OpenSSH
sudo ufw enable
# Do NOT `ufw allow 3000` unless you have auth in front of it.
```

To call the API from your laptop, use an SSH tunnel:
```bash
# on your laptop:
ssh -L 3000:127.0.0.1:3000 deploy@<server-ip>
# then locally: curl http://127.0.0.1:3000/health
```

If you front it with nginx + basic auth or an API key check, that's fine to expose.

## 9. Output files

Live in `/opt/serp-api/{screenshots,data,lighthouse}/`. Optionally rotate / clean:

```bash
# Crontab — delete artifacts older than 14 days
crontab -e
# Add:
0 4 * * * find /opt/serp-api/screenshots -type f -mtime +14 -delete
0 4 * * * find /opt/serp-api/data        -type f -mtime +14 -delete
0 4 * * * find /opt/serp-api/lighthouse  -type f -mtime +14 -delete
```

## 10. Updating

```bash
cd /opt/serp-api
git pull
npm ci
sudo systemctl restart serp-api.service
# Restart Chrome too if scripts/launch-chrome.sh or chrome flags changed:
sudo systemctl restart serp-chrome.service
```

## Troubleshooting

**`Running as root without --no-sandbox is not supported`**
You're launching Chrome as the root user. The launcher auto-adds `--no-sandbox` when it detects UID 0, so just pull the latest `scripts/launch-chrome.sh` (or set `ALLOW_NO_SANDBOX=true` explicitly). Better: create a non-root user, `chown -R` the project to them, and run as that user — that's the configuration the systemd units in §7 assume.

**`chromeConnected:false` from `/health`**
Chrome unit isn't up. `systemctl status serp-chrome` and `journalctl -u serp-chrome -n 100`. Common cause: missing system lib — re-run the apt deps from §1.

**`Browser CDP not reachable at http://127.0.0.1:9222`**
Same as above. Also check `ss -ltnp | grep 9222` to confirm Chrome is listening.

**Heavy CAPTCHAs / `still on /sorry/ after submit`**
On cloud IPs this is almost always IP reputation, not a code bug. Diagnose:
```bash
# 1. Inspect what Google actually served
ls -lt /opt/serp-api/diagnostics/ | head
# Open the *-before.html and *-before.png. If you see a normal reCAPTCHA v2
# checkbox, the solver should work. If you see "Our systems have detected
# unusual traffic" with no widget, or a different challenge, the IP is hard-blocked.

# 2. Quick clean-profile reset (only fixes profile-level flags, not IP flags)
sudo systemctl stop serp-chrome
rm -rf /opt/serp-api/chrome-profile
sudo systemctl start serp-chrome
```
If diagnostics show the token *is* being submitted but the page doesn't unblock, set `PROXY_SERVER` in `.env` to a residential proxy and `systemctl restart serp-chrome serp-api`. Verify `TWOCAPTCHA_API_KEY` and your 2captcha balance while you're there.

**Port 9222 already in use**
A stale Chrome is still around: `pkill -f google-chrome-stable`, then `systemctl start serp-chrome`.

**Memory pressure / OOM kills**
Lower `MemoryMax` in the chrome unit, or reduce email-crawl concurrency in [src/scrape.ts](src/scrape.ts) (the `5` argument to `findEmailsConcurrent`).

**Lighthouse hangs or times out**
Lighthouse opens its own tab via the same CDP port. If the headless profile is short on memory it will stall. 2GB is a lower bound; bump to 3–4GB if the server has it.
