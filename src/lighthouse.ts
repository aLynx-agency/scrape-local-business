import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lighthouse from "lighthouse";

const LH_DIR = "lighthouse";

export interface LighthouseSummary {
  finalUrl: string;
  fetchTime: string;
  scores: {
    performance: number | null;
    accessibility: number | null;
    bestPractices: number | null;
    seo: number | null;
  };
  metrics: {
    fcpMs: number | null;
    lcpMs: number | null;
    tbtMs: number | null;
    cls: number | null;
    speedIndexMs: number | null;
  };
}

export interface LighthouseResult {
  id: string;
  url: string;
  reportPath: string;
  summary: LighthouseSummary;
  lhr: unknown; // full Lighthouse Result object — large
}

export async function runLighthouse(targetUrl: string): Promise<LighthouseResult> {
  const port = Number(process.env.CDP_PORT ?? "9222");
  const result = await lighthouse(targetUrl, {
    port,
    output: "json",
    logLevel: "silent",
    onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
  });
  if (!result) throw new Error("Lighthouse returned no result");

  const lhr = result.lhr as LhrShape;
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  await mkdir(LH_DIR, { recursive: true });
  const reportPath = join(LH_DIR, `${id}.json`);
  await writeFile(reportPath, JSON.stringify(lhr, null, 2));

  const summary: LighthouseSummary = {
    finalUrl: lhr.finalUrl ?? lhr.finalDisplayedUrl ?? targetUrl,
    fetchTime: lhr.fetchTime,
    scores: {
      performance: lhr.categories.performance?.score ?? null,
      accessibility: lhr.categories.accessibility?.score ?? null,
      bestPractices: lhr.categories["best-practices"]?.score ?? null,
      seo: lhr.categories.seo?.score ?? null,
    },
    metrics: {
      fcpMs: lhr.audits["first-contentful-paint"]?.numericValue ?? null,
      lcpMs: lhr.audits["largest-contentful-paint"]?.numericValue ?? null,
      tbtMs: lhr.audits["total-blocking-time"]?.numericValue ?? null,
      cls: lhr.audits["cumulative-layout-shift"]?.numericValue ?? null,
      speedIndexMs: lhr.audits["speed-index"]?.numericValue ?? null,
    },
  };

  return { id, url: targetUrl, reportPath, summary, lhr };
}

// Minimal shape of what we read from the LHR — Lighthouse's TS types are heavy.
interface LhrShape {
  finalUrl?: string;
  finalDisplayedUrl?: string;
  fetchTime: string;
  categories: {
    performance?: { score: number | null };
    accessibility?: { score: number | null };
    "best-practices"?: { score: number | null };
    seo?: { score: number | null };
  };
  audits: Record<string, { numericValue?: number } | undefined>;
}
