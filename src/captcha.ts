import { setTimeout as sleep } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "patchright";

const API_BASE = "https://2captcha.com";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 24; // 24 * 5s = 2 min upper bound
const POST_SUBMIT_WAIT_MS = 30_000;
const DIAG_DIR = "diagnostics";

export function isBlocked(page: Page): boolean {
  const url = page.url();
  return url.includes("/sorry/") || url.includes("/blockpage") || url.includes("captcha");
}

/**
 * URL-based block check (`isBlocked`) misses Google's softer interstitial,
 * which lives on the original `/search?q=...` URL and just shows an "About this
 * page / Our systems have detected unusual traffic" body. Run this before
 * giving up on a page that "loaded" but might be a stealth block.
 */
export async function isBlockedDeep(page: Page): Promise<boolean> {
  if (isBlocked(page)) return true;

  const blockState = await page.evaluate(() => {
    const text = (document.body?.innerText ?? "").slice(0, 3000);
    const hasBlockText =
      /unusual traffic|automated queries|Our systems have detected|About this page|verify you('|’)?re not a robot/i.test(
        text,
      );
    const hasWidget = !!document.querySelector(
      "[data-sitekey], #recaptcha, .g-recaptcha, [data-hcaptcha-sitekey]",
    );
    const continueBtn = Array.from(document.querySelectorAll("button, input[type='submit'], a")).find(
      (el) => /^(Continue|Continuer|Doorgaan|Verder|Weiter)$/i.test((el.textContent ?? "").trim()),
    ) as HTMLElement | null;
    return { hasBlockText, hasWidget, hasContinue: !!continueBtn };
  });

  if (!blockState.hasBlockText && !blockState.hasWidget) return false;

  if (blockState.hasContinue && !blockState.hasWidget) {
    console.log("[captcha] soft interstitial detected, clicking Continue…");
    await page
      .evaluate(() => {
        const btn = Array.from(
          document.querySelectorAll("button, input[type='submit'], a"),
        ).find((el) => /^(Continue|Continuer|Doorgaan|Verder|Weiter)$/i.test((el.textContent ?? "").trim())) as
          | HTMLElement
          | null;
        btn?.click();
      })
      .catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  return true;
}

/**
 * Detects Google's CAPTCHA challenge page and solves it via 2captcha if
 * `TWOCAPTCHA_API_KEY` is set. Returns true if we navigated past the block,
 * false otherwise. On failure, dumps before/after HTML+screenshot to
 * diagnostics/ AND prints a detailed step-by-step log of what happened so
 * you don't have to inspect the dump to know where it broke.
 */
export async function solveIfBlocked(page: Page): Promise<boolean> {
  if (!(await isBlockedDeep(page))) return false;

  const t0 = Date.now();
  const diagId = new Date().toISOString().replace(/[:.]/g, "-");
  const startUrl = page.url();
  const startTitle = await page.title().catch(() => "<no-title>");
  const reportedIp = await readReportedIp(page);

  console.log("[captcha] ─── solve start ────────────────────────────────────");
  console.log(`[captcha] diag-id: ${diagId}`);
  console.log(`[captcha] page url: ${startUrl}`);
  console.log(`[captcha] page title: ${startTitle}`);
  if (reportedIp) console.log(`[captcha] IP shown by Google: ${reportedIp}`);

  await dumpDiagnostic(page, diagId, "before");

  const apiKey = process.env.TWOCAPTCHA_API_KEY;
  if (!apiKey) {
    console.warn("[captcha] FAIL: TWOCAPTCHA_API_KEY not set — cannot solve");
    return false;
  }
  console.log(`[captcha] api key: …${apiKey.slice(-4)} (length ${apiKey.length})`);

  const challenge = await detectChallenge(page);
  console.log(
    `[captcha] challenge: type=${challenge.type}` +
      `${challenge.enterprise ? " enterprise=true" : ""}` +
      `, sitekey=${challenge.siteKey ?? "<none>"}` +
      `, data-s=${challenge.dataS ? `${challenge.dataS.slice(0, 16)}…(${challenge.dataS.length})` : "MISSING"}` +
      `, cookies=${challenge.cookies ? `${challenge.cookies.length} chars` : "MISSING"}` +
      `, ua=${challenge.userAgent.slice(0, 60)}…`,
  );
  if (challenge.callbackName) {
    console.log(`[captcha] data-callback present: ${challenge.callbackName}`);
  }

  if (challenge.type === "none") {
    console.warn("[captcha] FAIL: no recognized challenge widget on page");
    console.warn("[captcha]   This usually means the block is interstitial-only (no captcha to solve).");
    console.warn("[captcha]   Driven by IP reputation. Use a residential proxy or wait 24–48h for the flag to expire.");
    return false;
  }
  if (!challenge.siteKey) {
    console.warn("[captcha] FAIL: challenge widget present but no sitekey extractable");
    return false;
  }

  const submitTime = Date.now();
  const submitOutcome = await solveRecaptchaV2(apiKey, challenge.siteKey, startUrl, challenge.enterprise, {
    dataS: challenge.dataS,
    userAgent: challenge.userAgent,
    cookies: challenge.cookies,
  });
  const ageSeconds = Math.round((Date.now() - submitTime) / 1000);

  if (submitOutcome.kind !== "ok") {
    console.warn(`[captcha] FAIL: 2captcha did not return a token (${submitOutcome.kind}: ${submitOutcome.detail})`);
    console.warn(`[captcha]   total time waiting: ${ageSeconds}s`);
    if (submitOutcome.kind === "submit-error") {
      console.warn("[captcha]   2captcha rejected our task before solving even started.");
      console.warn(`[captcha]   Common codes: ERROR_GOOGLEKEY (bad sitekey), ERROR_BAD_PARAMETERS,`);
      console.warn(`[captcha]   ERROR_ZERO_BALANCE, ERROR_NO_SLOT_AVAILABLE.`);
    } else if (submitOutcome.kind === "poll-error") {
      console.warn("[captcha]   2captcha started solving but reported an error.");
      console.warn("[captcha]   ERROR_CAPTCHA_UNSOLVABLE → too hard to solve; retry usually picks a different worker.");
    } else if (submitOutcome.kind === "poll-timeout") {
      console.warn(`[captcha]   We polled ${MAX_POLL_ATTEMPTS} times (${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s) and never got CAPCHA_OK.`);
    }
    await dumpDiagnostic(page, diagId, "no-token");
    return false;
  }

  const token = submitOutcome.token;
  console.log(`[captcha] token received in ${ageSeconds}s (length ${token.length}), submitting to page…`);
  if (ageSeconds > 110) {
    console.warn(`[captcha]   WARNING: token age (${ageSeconds}s) close to Google's ~120s expiry. May be rejected on submit.`);
  }

  const injection = await injectAndSubmit(page, token);
  console.log(`[captcha] inject summary: ${JSON.stringify(injection)}`);
  if (!injection.callbackInvoked && !injection.buttonClicked && !injection.formSubmitted) {
    console.warn("[captcha]   None of the submission strategies fired. The page DOM doesn't match any expected pattern.");
  }

  // Track URL changes during the wait. If Google bounces us through several
  // intermediate URLs (consent, redirect, /sorry/index → /search), we want to
  // see the trajectory, not just the final state.
  const urlTrajectory = await waitForUnblock(page, POST_SUBMIT_WAIT_MS);
  const finalUrl = page.url();
  const finalTitle = await page.title().catch(() => "<no-title>");

  console.log(`[captcha] post-submit URL trajectory (${urlTrajectory.length} change(s)):`);
  for (const change of urlTrajectory) {
    console.log(`[captcha]   +${change.tMs}ms  ${change.url}`);
  }
  console.log(`[captcha] final URL: ${finalUrl}`);
  console.log(`[captcha] final title: ${finalTitle}`);

  if (isBlocked(page)) {
    console.warn(`[captcha] FAIL: still blocked after submit + ${POST_SUBMIT_WAIT_MS}ms wait`);

    // Re-detect challenge to see if Google issued a fresh one (different
    // sitekey/data-s) or kept the same. Same → token rejected silently;
    // different → Google issued a new challenge after consuming our token.
    const after = await detectChallenge(page);
    if (after.siteKey === challenge.siteKey && after.dataS === challenge.dataS) {
      console.warn("[captcha]   Same challenge as before — Google rejected the token without consuming it.");
    } else if (after.siteKey) {
      console.warn(`[captcha]   FRESH challenge issued (data-s changed from ${challenge.dataS?.slice(0, 12)}… to ${after.dataS?.slice(0, 12)}…).`);
      console.warn("[captcha]   Google accepted our submit but immediately re-blocked. Almost always a residual fingerprint/IP signal.");
    } else {
      console.warn("[captcha]   Page changed but is still on /sorry/ without a captcha widget — likely a hard interstitial now.");
    }

    const afterIp = await readReportedIp(page);
    if (reportedIp && afterIp && reportedIp !== afterIp) {
      console.warn(`[captcha]   IP CHANGED during solve: ${reportedIp} → ${afterIp}`);
      console.warn("[captcha]   The proxy rotated mid-flow. Need sticky sessions (see SERVER_SETUP.md).");
    } else if (reportedIp && afterIp) {
      console.warn(`[captcha]   IP stable across solve: ${afterIp}`);
    }

    console.warn(`[captcha]   token age at submit: ${ageSeconds}s ${ageSeconds > 110 ? "(near expiry — may be why)" : ""}`);
    console.warn(`[captcha]   diagnostics: diagnostics/${diagId}-{before,after}.{html,png}`);
    console.warn(`[captcha]   total solve time: ${Math.round((Date.now() - t0) / 1000)}s`);
    await dumpDiagnostic(page, diagId, "after");
    return false;
  }

  console.log(`[captcha] PASS — block cleared in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log("[captcha] ─── solve end ──────────────────────────────────────");
  return true;
}

async function readReportedIp(page: Page): Promise<string | null> {
  // Google's /sorry/ page prints "IP address: X" in the body. Reading it lets
  // us see what Google actually saw — the residential exit IP, not what we
  // configured. Worth catching mismatches between what the proxy says and
  // what hits Google.
  return await page
    .evaluate(() => {
      const m = (document.body?.innerText ?? "").match(/IP address:\s*([\d.]+(?:\s*[≠=]\s*[\d.]+)?)/i);
      return m?.[1]?.trim() ?? null;
    })
    .catch(() => null);
}

async function waitForUnblock(
  page: Page,
  totalMs: number,
): Promise<Array<{ tMs: number; url: string }>> {
  const start = Date.now();
  const trajectory: Array<{ tMs: number; url: string }> = [];
  let lastUrl = page.url();
  trajectory.push({ tMs: 0, url: lastUrl });
  while (Date.now() - start < totalMs) {
    await page.waitForTimeout(500);
    const current = page.url();
    if (current !== lastUrl) {
      trajectory.push({ tMs: Date.now() - start, url: current });
      lastUrl = current;
    }
    if (!isBlocked(page)) break;
  }
  return trajectory;
}

type Challenge = {
  type: "recaptcha-v2" | "recaptcha-invisible" | "hcaptcha" | "none";
  siteKey: string | null;
  enterprise: boolean;
  dataS: string | null;
  callbackName: string | null;
  userAgent: string;
  cookies: string;
};

async function detectChallenge(page: Page): Promise<Challenge> {
  return await page.evaluate<Challenge>(() => {
    const enterprise = !!document.querySelector('script[src*="recaptcha/enterprise"]');
    const userAgent = navigator.userAgent;
    const cookies = document.cookie;

    const hc = document.querySelector("[data-hcaptcha-sitekey], .h-captcha[data-sitekey]");
    if (hc) {
      return {
        type: "hcaptcha",
        siteKey:
          hc.getAttribute("data-hcaptcha-sitekey") ?? hc.getAttribute("data-sitekey") ?? null,
        enterprise: false,
        dataS: null,
        callbackName: null,
        userAgent,
        cookies,
      };
    }

    const rc =
      document.querySelector(".g-recaptcha[data-sitekey]") ??
      document.querySelector("[data-sitekey]");
    if (rc) {
      const size = rc.getAttribute("data-size") ?? "";
      return {
        type: size === "invisible" ? "recaptcha-invisible" : "recaptcha-v2",
        siteKey: rc.getAttribute("data-sitekey"),
        enterprise,
        dataS: rc.getAttribute("data-s"),
        callbackName: rc.getAttribute("data-callback"),
        userAgent,
        cookies,
      };
    }

    return {
      type: "none",
      siteKey: null,
      enterprise: false,
      dataS: null,
      callbackName: null,
      userAgent,
      cookies,
    };
  });
}

interface InjectResult {
  textareasFound: number;
  callbackInvoked: boolean;
  callbackName: string | null;
  buttonClicked: string | null;
  formSubmitted: boolean;
  errors: string[];
}

async function injectAndSubmit(page: Page, token: string): Promise<InjectResult> {
  return await page.evaluate((tok: string) => {
    const result: InjectResult = {
      textareasFound: 0,
      callbackInvoked: false,
      callbackName: null,
      buttonClicked: null,
      formSubmitted: false,
      errors: [],
    };

    // 1. Stuff the token into every g-recaptcha-response textarea.
    const textareas = document.querySelectorAll<HTMLTextAreaElement>("textarea[name='g-recaptcha-response']");
    result.textareasFound = textareas.length;
    textareas.forEach((t) => {
      t.style.display = "block";
      t.value = tok;
      t.innerHTML = tok;
      t.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const ta = document.getElementById("g-recaptcha-response") as HTMLTextAreaElement | null;
    if (ta && !textareas.length) {
      result.textareasFound = 1;
      ta.style.display = "block";
      ta.value = tok;
      ta.innerHTML = tok;
      ta.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // 2. Invoke the data-callback function (modern /sorry/ submission path).
    const widget = document.querySelector("[data-callback]");
    const cbName = widget?.getAttribute("data-callback");
    result.callbackName = cbName ?? null;
    type WindowWithCallback = Window & { [key: string]: ((arg: string) => void) | undefined };
    const w = window as unknown as WindowWithCallback;
    if (cbName && typeof w[cbName] === "function") {
      try {
        w[cbName](tok);
        result.callbackInvoked = true;
      } catch (e) {
        result.errors.push(`callback ${cbName} threw: ${(e as Error).message}`);
      }
    } else if (cbName) {
      result.errors.push(`callback ${cbName} declared but not defined on window`);
    }

    // 3. Click any visible verify/submit button (some flows still need this
    // even after the callback fires — modern /sorry/ has a hidden submit).
    const buttonTexts = ["Verzenden", "Submit", "Verifiëren", "Verify", "Versturen", "Envoyer", "Continue", "Continuer", "Doorgaan"];
    for (const txt of buttonTexts) {
      const btn = Array.from(document.querySelectorAll("button, input[type='submit']")).find(
        (b) => (b.textContent ?? (b as HTMLInputElement).value ?? "").trim() === txt,
      ) as HTMLElement | null;
      if (btn) {
        btn.click();
        result.buttonClicked = txt;
        break;
      }
    }

    // 4. Form submit fallback. Modern /sorry/ submissions may have already
    // gone through via callback; this catches the legacy flow where the form
    // is the entire submission mechanism.
    const form = document.querySelector("form") as HTMLFormElement | null;
    if (form && !result.callbackInvoked) {
      try {
        form.submit();
        result.formSubmitted = true;
      } catch (e) {
        result.errors.push(`form.submit() threw: ${(e as Error).message}`);
      }
    }

    return result;
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

type SubmitOutcome =
  | { kind: "ok"; token: string }
  | { kind: "fetch-error"; detail: string }
  | { kind: "submit-error"; detail: string }
  | { kind: "poll-error"; detail: string }
  | { kind: "poll-timeout"; detail: string };

async function solveRecaptchaV2(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  enterprise: boolean,
  extra: { dataS: string | null; userAgent: string; cookies: string },
): Promise<SubmitOutcome> {
  const params = new URLSearchParams({
    key: apiKey,
    method: "userrecaptcha",
    googlekey: siteKey,
    pageurl: pageUrl,
    json: "1",
  });
  if (enterprise) params.set("enterprise", "1");
  if (extra.dataS) params.set("data-s", extra.dataS);
  if (extra.userAgent) params.set("userAgent", extra.userAgent);
  if (extra.cookies) params.set("cookies", extra.cookies);

  // Log the params we're sending (mask the API key for safety).
  const safeParams = new URLSearchParams(params);
  safeParams.set("key", `…${apiKey.slice(-4)}`);
  if (safeParams.has("cookies")) safeParams.set("cookies", `<${extra.cookies.length} chars>`);
  if (safeParams.has("data-s")) safeParams.set("data-s", `<${extra.dataS?.length ?? 0} chars>`);
  console.log(`[captcha] 2captcha submit: ${API_BASE}/in.php?${safeParams.toString()}`);

  const submitUrl = `${API_BASE}/in.php?${params.toString()}`;
  let submitRes: Response | null = null;
  try {
    submitRes = await fetch(submitUrl);
  } catch (e) {
    return { kind: "fetch-error", detail: `submit fetch failed: ${(e as Error).message}` };
  }
  if (!submitRes.ok) {
    return { kind: "fetch-error", detail: `submit HTTP ${submitRes.status}` };
  }
  const submit = (await submitRes.json().catch(() => ({}))) as {
    status?: number;
    request?: string;
    error_text?: string;
  };
  console.log(`[captcha] 2captcha submit response: ${JSON.stringify(submit)}`);

  if (submit.status !== 1 || !submit.request) {
    return {
      kind: "submit-error",
      detail: `${submit.request ?? "<unknown>"}${submit.error_text ? ` — ${submit.error_text}` : ""}`,
    };
  }
  const taskId = submit.request;
  console.log(`[captcha] 2captcha task id: ${taskId}, polling…`);

  const pollStart = Date.now();
  for (let i = 1; i <= MAX_POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const pollUrl = `${API_BASE}/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`;
    let pollRes: Response | null = null;
    try {
      pollRes = await fetch(pollUrl);
    } catch (e) {
      console.log(`[captcha] poll ${i}/${MAX_POLL_ATTEMPTS}: network error: ${(e as Error).message}`);
      continue;
    }
    if (!pollRes.ok) {
      console.log(`[captcha] poll ${i}/${MAX_POLL_ATTEMPTS}: HTTP ${pollRes.status}`);
      continue;
    }
    const poll = (await pollRes.json().catch(() => ({}))) as {
      status?: number;
      request?: string;
    };
    const elapsed = Math.round((Date.now() - pollStart) / 1000);
    if (poll.status === 1 && poll.request) {
      console.log(`[captcha] poll ${i}/${MAX_POLL_ATTEMPTS} (${elapsed}s): SOLVED`);
      return { kind: "ok", token: poll.request };
    }
    if (poll.request && poll.request !== "CAPCHA_NOT_READY") {
      return { kind: "poll-error", detail: poll.request };
    }
    console.log(`[captcha] poll ${i}/${MAX_POLL_ATTEMPTS} (${elapsed}s): not ready`);
  }
  return { kind: "poll-timeout", detail: `gave up after ${MAX_POLL_ATTEMPTS} polls` };
}
