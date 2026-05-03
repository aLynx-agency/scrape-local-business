// In-process job queue for both /scrape and /lighthouse. Single worker, single
// FIFO queue across both job types — they share the underlying Brave instance
// over CDP, so running them in parallel would have the two clients fighting
// over the same browser.
//
// Jobs live in memory for the lifetime of the process. Restart loses pending
// state — fine for n8n usage where each workflow run is independent and a
// caller that didn't get an answer can resubmit.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { scrape } from "./scrape.ts";
import { runLighthouse, type LighthouseResult } from "./lighthouse.ts";
import type { ScrapeResponse } from "./types.ts";

export type JobStatus = "queued" | "running" | "done" | "failed";

interface JobBase {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface ScrapeJob extends JobBase {
  type: "scrape";
  query: string;
  maxPages: number;
  result?: ScrapeResponse & { screenshotBase64: string };
}

export interface LighthouseJob extends JobBase {
  type: "lighthouse";
  url: string;
  full: boolean;
  // When `full` is false we drop the heavy `lhr` field from the response so
  // the polling reply stays small.
  result?: Omit<LighthouseResult, "lhr"> & { lhr?: unknown };
}

export type Job = ScrapeJob | LighthouseJob;

const jobs = new Map<string, Job>();
const queue: string[] = [];
let workerActive = false;

export function enqueueScrape(query: string, maxPages: number): ScrapeJob {
  const job: ScrapeJob = {
    type: "scrape",
    jobId: randomUUID(),
    status: "queued",
    query,
    maxPages,
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.jobId, job);
  queue.push(job.jobId);
  startWorker();
  return job;
}

export function enqueueLighthouse(url: string, full: boolean): LighthouseJob {
  const job: LighthouseJob = {
    type: "lighthouse",
    jobId: randomUUID(),
    status: "queued",
    url,
    full,
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.jobId, job);
  queue.push(job.jobId);
  startWorker();
  return job;
}

export function getJob(jobId: string): (Job & { queuePosition?: number }) | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.status === "queued") {
    const idx = queue.indexOf(jobId);
    return { ...job, queuePosition: idx < 0 ? 0 : idx };
  }
  return job;
}

export function listJobs(filterType?: Job["type"]): Job[] {
  const all = Array.from(jobs.values());
  const filtered = filterType ? all.filter((j) => j.type === filterType) : all;
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function startWorker() {
  if (workerActive) return;
  workerActive = true;
  void runWorker().finally(() => {
    workerActive = false;
  });
}

async function runWorker(): Promise<void> {
  while (queue.length > 0) {
    const jobId = queue.shift();
    if (!jobId) continue;
    const job = jobs.get(jobId);
    if (!job) continue;

    job.status = "running";
    job.startedAt = new Date().toISOString();
    try {
      if (job.type === "scrape") {
        await runScrape(job);
      } else {
        await runLighthouseJob(job);
      }
      job.status = "done";
    } catch (e) {
      job.error = (e as Error).message;
      job.status = "failed";
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }
}

async function runScrape(job: ScrapeJob): Promise<void> {
  const result = await scrape(job.query, job.maxPages);
  // Inline the screenshot so n8n gets everything in the polling response and
  // doesn't need a follow-up file fetch. ~300–500 KB base64 per scrape.
  const screenshotBase64 = await readFile(result.screenshotPath, "base64").catch((e) => {
    console.warn(`[jobs] could not read screenshot for ${job.jobId}: ${(e as Error).message}`);
    return "";
  });
  job.result = { ...result, screenshotBase64 };
}

async function runLighthouseJob(job: LighthouseJob): Promise<void> {
  const result = await runLighthouse(job.url);
  if (job.full) {
    job.result = result;
  } else {
    // Drop the heavy `lhr` field — clients that want it can pass `full: true`.
    // The summary is what most callers actually need.
    const { lhr: _drop, ...lite } = result;
    void _drop;
    job.result = lite;
  }
}
