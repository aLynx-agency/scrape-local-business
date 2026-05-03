import Fastify from "fastify";
import { isReachable } from "./chrome.ts";
import {
  enqueueLighthouse,
  enqueueScrape,
  getJob,
  listJobs,
  type Job,
} from "./jobs.ts";

const fastify = Fastify({ logger: true });

fastify.get("/health", async () => {
  const chromeConnected = await isReachable();
  return { ok: true, chromeConnected };
});

// Async pattern for n8n: POST submits and returns immediately with a jobId,
// then GET /<endpoint>/:jobId polls for status + result. One job runs at a
// time on the server — scrape and lighthouse share the underlying Brave
// instance, so they can't safely run in parallel anyway.

// ---------- /scrape ----------

fastify.post<{ Body: { query?: string; maxPages?: number } }>("/scrape", async (req, reply) => {
  const query = req.body?.query?.trim();
  if (!query) {
    return reply.code(400).send({ error: "missing 'query' in body" });
  }
  const maxPages = Math.max(1, Math.min(10, req.body?.maxPages ?? 4));
  const job = enqueueScrape(query, maxPages);
  return reply.code(202).send({
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    query: job.query,
    maxPages: job.maxPages,
    createdAt: job.createdAt,
    pollUrl: `/scrape/${job.jobId}`,
  });
});

fastify.get<{ Params: { jobId: string } }>("/scrape/:jobId", async (req, reply) => {
  const job = getJob(req.params.jobId);
  if (!job) return reply.code(404).send({ error: "job not found" });
  if (job.type !== "scrape") {
    return reply.code(400).send({ error: `job ${req.params.jobId} is a ${job.type} job — poll /${job.type}/:jobId instead` });
  }
  return job;
});

fastify.get("/scrape", async () => {
  return { jobs: listJobs("scrape").slice(0, 50).map(scrapeListItem) };
});

// ---------- /lighthouse ----------

fastify.post<{ Body: { url?: string; full?: boolean } }>("/lighthouse", async (req, reply) => {
  const url = req.body?.url?.trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return reply.code(400).send({ error: "missing or invalid 'url' in body" });
  }
  // Default to returning the full LHR (~1 MB JSON). Pass `"full": false` to
  // get just the summary if the payload size becomes a problem downstream.
  const full = req.body?.full !== false;
  const job = enqueueLighthouse(url, full);
  return reply.code(202).send({
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    url: job.url,
    full: job.full,
    createdAt: job.createdAt,
    pollUrl: `/lighthouse/${job.jobId}`,
  });
});

fastify.get<{ Params: { jobId: string } }>("/lighthouse/:jobId", async (req, reply) => {
  const job = getJob(req.params.jobId);
  if (!job) return reply.code(404).send({ error: "job not found" });
  if (job.type !== "lighthouse") {
    return reply.code(400).send({ error: `job ${req.params.jobId} is a ${job.type} job — poll /${job.type}/:jobId instead` });
  }
  return job;
});

fastify.get("/lighthouse", async () => {
  return { jobs: listJobs("lighthouse").slice(0, 50).map(lighthouseListItem) };
});

// Lightweight list views — strip heavy fields (screenshotBase64, full lhr) so
// the listing endpoint stays small even after many jobs.
function scrapeListItem(j: Job) {
  if (j.type !== "scrape") return null;
  return {
    jobId: j.jobId,
    type: j.type,
    status: j.status,
    query: j.query,
    maxPages: j.maxPages,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    error: j.error,
    resultCount: j.result?.results.length,
  };
}

function lighthouseListItem(j: Job) {
  if (j.type !== "lighthouse") return null;
  return {
    jobId: j.jobId,
    type: j.type,
    status: j.status,
    url: j.url,
    full: j.full,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    error: j.error,
    perfScore: j.result?.summary?.scores.performance ?? null,
  };
}

const port = Number(process.env.PORT ?? 3000);
fastify
  .listen({ port, host: "0.0.0.0" })
  .then(() => fastify.log.info(`API ready on :${port}`))
  .catch((err) => {
    fastify.log.error(err);
    process.exit(1);
  });
