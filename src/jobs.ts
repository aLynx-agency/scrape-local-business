// In-process job queue. One worker, one scrape at a time — keeps Brave from
// drowning in concurrent tabs and prevents Google from seeing parallel queries
// off the same residential IP (which gets you /sorry/'d faster than serial).
//
// Jobs are kept in memory for the lifetime of the process. A restart loses
// queue state — fine for n8n usage where each workflow run is independent and
// callers that didn't get an answer can just resubmit.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { scrape } from "./scrape.ts";
import type { ScrapeResponse } from "./types.ts";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  jobId: string;
  status: JobStatus;
  query: string;
  maxPages: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  // queuePosition is computed on read for queued jobs (0 = next up).
  result?: ScrapeResponse & { screenshotBase64: string };
  error?: string;
}

const jobs = new Map<string, Job>();
const queue: string[] = [];
let workerActive = false;

export function enqueueScrape(query: string, maxPages: number): Job {
  const jobId = randomUUID();
  const job: Job = {
    jobId,
    status: "queued",
    query,
    maxPages,
    createdAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);
  queue.push(jobId);
  startWorker();
  return job;
}

export function getJob(jobId: string): (Job & { queuePosition?: number }) | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.status === "queued") {
    const queuePosition = queue.indexOf(jobId);
    return { ...job, queuePosition: queuePosition < 0 ? 0 : queuePosition };
  }
  return job;
}

export function listJobs(): Job[] {
  return Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function startWorker() {
  if (workerActive) return;
  workerActive = true;
  // Detach so the enqueue caller returns immediately.
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
      const result = await scrape(job.query, job.maxPages);
      // Inline the screenshot so n8n gets everything in the polling response
      // and doesn't need a follow-up file fetch. ~300–500 KB base64 per scrape.
      const screenshotBase64 = await readFile(result.screenshotPath, "base64").catch((e) => {
        console.warn(`[jobs] could not read screenshot for ${jobId}: ${(e as Error).message}`);
        return "";
      });
      job.result = { ...result, screenshotBase64 };
      job.status = "done";
    } catch (e) {
      job.error = (e as Error).message;
      job.status = "failed";
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }
}
