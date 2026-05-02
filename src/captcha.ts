import { setTimeout as sleep } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

const API_BASE = "https://2captcha.com";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 24; // 24 * 5s = 2 min upper bound
const DIAG_DIR = "diagnostics";

export function isBlocked(page: Page): boolean {
  const url = page.url();
  return url.includes("/sorry/") || url.includes("/blockpage") || url.includes("captcha");
}

/**
 * Detects Google's CAPTCHA challenge page and solves it via 2captcha if
 * `TWOCAPTCHA_API_KEY` is set. Returns true if a CAPTCHA was solved (and the
 * page navigated past the block), false if no CAPTCHA was present or solving failed.
 *
 * On any solve failure (no sitekey, 2captcha refused, or page didn't unblock),
 * dumps the /sorry/ HTML + a screenshot to ./diagnostics/ so you can see what
 * Google actually served. The 90% failure mode on cloud IPs is that the token
 * is correct but Google rejects it because the IP itself is flagged — diagnostics
 * make that distinguishable from a code bug.
 */
export async function solveIfBlocked(page: Page): Promise<boolean> {
  if (!isBlocked(page)) return false;

  const diagId = new Date().toISOString().replace(/[:.]/g, "-");
  await dumpDiagnostic(page, diagId, "before");

  const apiKey = process.env.TWOCAPTCHA_API_KEY;
  if (!apiKey) {
    console.warn("[captcha] block detected but no TWOCAPTCHA_API_KEY set — cannot solve");
    return false;
  }

  const pageUrl = page.url();
  const challenge = await detectChallenge(page);
  console.log(
    `[captcha] challenge type: ${challenge.type}${challenge.enterprise ? " (enterprise)" : ""}, sitekey: ${challenge.siteKey ?? "<none>"}`,
  );

  if (challenge.type === "none") {
    console.warn("[captcha] no recognized challenge widget on /sorry/ page — likely interstitial-only block (IP-driven). See diagnostics/.");
    return false;
  }
  if (!challenge.siteKey) {
    console.warn("[captcha] challenge detected but no sitekey extractable. See diagnostics/.");
    return false;
  }

  console.log("[captcha] block detected, submitting to 2captcha…");
  const submitTime = Date.now();
  const token = await solveRecaptchaV2(apiKey, challenge.siteKey, pageUrl, challenge.enterprise);
  if (!token) {
    console.warn("[captcha] 2captcha did not return a token");
    await dumpDiagnostic(page, diagId, "no-token");
    return false;
  }
  const ageSeconds = Math.round((Date.now() - submitTime) / 1000);
  console.log(`[captcha] token received after ${ageSeconds}s, injecting and submitting`);

  await injectAndSubmit(page, token);

  // Wait up to 30s for navigation away from /sorry/. Google sometimes serves
  // a second confirmation step after token submit, and headless on a flagged IP
  // can take noticeably longer than headed before either accepting or rebouncing.
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    if (!isBlocked(page)) break;
  }
  await page.waitForTimeout(500);

  if (isBlocked(page)) {
    console.warn("[captcha] still on /sorry/ after submit — solve failed");
    console.warn(`[captcha]   token age at submit: ${ageSeconds}s (Google tokens expire ~120s)`);
    console.warn(`[captcha]   See diagnostics/${diagId}-*.html / .png to inspect what Google served.`);
    console.warn("[captcha]   Most common cause on cloud IPs: token correct but IP reputation triggers a second-stage rejection. Use a residential proxy via PROXY_SERVER.");
    await dumpDiagnostic(page, diagId, "after");
    return false;
  }

  console.log("[captcha] passed block");
  return true;
}

type Challenge = {
  type: "recaptcha-v2" | "recaptcha-invisible" | "hcaptcha" | "none";
  siteKey: string | null;
  enterprise: boolean;
};

async function detectChallenge(page: Page): Promise<Challenge> {
  return await page.evaluate<Challenge>(() => {
    // Enterprise reCAPTCHA loads a different script. Visually identical to v2
    // but tokens issued for one don't validate against the other — 2captcha
    // needs `enterprise=1` set when submitting.
    const enterprise = !!document.querySelector('script[src*="recaptcha/enterprise"]');

    // hCaptcha
    const hc = document.querySelector("[data-hcaptcha-sitekey], .h-captcha[data-sitekey]");
    if (hc) {
      return {
        type: "hcaptcha",
        siteKey:
          hc.getAttribute("data-hcaptcha-sitekey") ?? hc.getAttribute("data-sitekey") ?? null,
        enterprise: false,
      };
    }
    // reCAPTCHA — both v2 and invisible expose data-sitekey on the widget
    const rc =
      document.querySelector(".g-recaptcha[data-sitekey]") ??
      document.querySelector("[data-sitekey]");
    if (rc) {
      const size = rc.getAttribute("data-size") ?? "";
      return {
        type: size === "invisible" ? "recaptcha-invisible" : "recaptcha-v2",
        siteKey: rc.getAttribute("data-sitekey"),
        enterprise,
      };
    }
    return { type: "none", siteKey: null, enterprise: false };
  });
}

async function injectAndSubmit(page: Page, token: string): Promise<void> {
  await page.evaluate((tok: string) => {
    // 1. Stuff the token into every g-recaptcha-response textarea — there's
    // sometimes more than one (visible + hidden inside an iframe-bridge form).
    document.querySelectorAll<HTMLTextAreaElement>("textarea[name='g-recaptcha-response']").forEach((t) => {
      t.style.display = "block";
      t.value = tok;
      t.innerHTML = tok;
      t.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const ta = document.getElementById("g-recaptcha-response") as HTMLTextAreaElement | null;
    if (ta) {
      ta.style.display = "block";
      ta.value = tok;
      ta.innerHTML = tok;
      ta.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // 2. Modern Google /sorry/ uses a JS callback registered via `data-callback`.
    // Invoking it is what actually unblocks the submit; raw form.submit() alone
    // gets ignored by current /sorry/ pages.
    const widget = document.querySelector("[data-callback]");
    const cbName = widget?.getAttribute("data-callback");
    type WindowWithCallback = Window & { [key: string]: ((arg: string) => void) | undefined };
    const w = window as unknown as WindowWithCallback;
    if (cbName && typeof w[cbName] === "function") {
      try {
        w[cbName](tok);
      } catch {
        // fall through to form submit
      }
    }

    // 3. Click any visible verify/submit button, in case the callback didn't
    // trigger the navigation itself.
    const buttonTexts = ["Verzenden", "Submit", "Verifiëren", "Verify", "Versturen", "Envoyer", "Continue", "Continuer", "Doorgaan"];
    for (const txt of buttonTexts) {
      const btn = Array.from(document.querySelectorAll("button, input[type='submit']")).find(
        (b) => (b.textContent ?? (b as HTMLInputElement).value ?? "").trim() === txt,
      ) as HTMLElement | null;
      if (btn) {
        btn.click();
        return;
      }
    }

    // 4. Fallback: submit the form directly.
    const form = document.querySelector("form") as HTMLFormElement | null;
    if (form) form.submit();
  }, token);
}

async function dumpDiagnostic(page: Page, id: string, label: string): Promise<void> {
  try {
    await mkdir(DIAG_DIR, { recursive: true });
    const html = await page.content().catch(() => "<unavailable>");
    await writeFile(join(DIAG_DIR, `${id}-${label}.html`), html);
    await page
      .screenshot({ path: join(DIAG_DIR, `${id}-${label}.png`), fullPage: true })
      .catch(() => {});
  } catch (e) {
    console.warn(`[captcha] failed to dump diagnostic (${label}): ${(e as Error).message}`);
  }
}

async function solveRecaptchaV2(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  enterprise: boolean,
): Promise<string | null> {
  // For reCAPTCHA Enterprise, 2captcha needs `enterprise=1` — Enterprise tokens
  // are scored against a different verifier and submitting a regular-v2 task
  // returns a syntactically valid token that Google rejects on form post.
  const enterpriseFlag = enterprise ? "&enterprise=1" : "";
  const submitUrl = `${API_BASE}/in.php?key=${apiKey}&method=userrecaptcha&googlekey=${encodeURIComponent(siteKey)}&pageurl=${encodeURIComponent(pageUrl)}${enterpriseFlag}&json=1`;
  const submitRes = await fetch(submitUrl).catch(() => null);
  if (!submitRes || !submitRes.ok) return null;
  const submit = (await submitRes.json()) as { status: number; request: string; error_text?: string };
  if (submit.status !== 1) {
    console.warn(`[captcha] 2captcha submit failed: ${submit.request} ${submit.error_text ?? ""}`);
    return null;
  }
  const taskId = submit.request;

  // Poll for result
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const pollUrl = `${API_BASE}/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`;
    const pollRes = await fetch(pollUrl).catch(() => null);
    if (!pollRes || !pollRes.ok) continue;
    const poll = (await pollRes.json()) as { status: number; request: string };
    if (poll.status === 1) return poll.request;
    if (poll.request !== "CAPCHA_NOT_READY") {
      console.warn(`[captcha] 2captcha poll error: ${poll.request}`);
      return null;
    }
  }
  console.warn("[captcha] 2captcha timed out waiting for solution");
  return null;
}
