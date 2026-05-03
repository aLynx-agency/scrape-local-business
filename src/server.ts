import Fastify from "fastify";
import { closeOpenedPages, isReachable } from "./chrome.ts";
import { runLighthouse } from "./lighthouse.ts";
import { enqueueScrape, getJob, listJobs } from "./jobs.ts";

const fastify = Fastify({ logger: true });

fastify.get("/health", async () => {
  const chromeConnected = await isReachable();
  return { ok: true, chromeConnected };
});

// Async pattern for n8n: POST submits and returns immediately with a jobId,
// then GET /scrape/:jobId polls for status + result. One scrape runs at a
// time on the server (single Brave instance, single residential IP — parallel
// scraping would just trip Google's bot detection faster anyway).
fastify.post<{ Body: { query?: string; maxPages?: number } }>("/scrape", async (req, reply) => {
  const query = req.body?.query?.trim();
  if (!query) {
    return reply.code(400).send({ error: "missing 'query' in body" });
  }
  const maxPages = Math.max(1, Math.min(10, req.body?.maxPages ?? 4));
  const job = enqueueScrape(query, maxPages);
  return reply.code(202).send({
    jobId: job.jobId,
    status: job.status,
    query: job.query,
    maxPages: job.maxPages,
    createdAt: job.createdAt,
    pollUrl: `/scrape/${job.jobId}`,
  });
});

fastify.get<{ Params: { jobId: string } }>("/scrape/:jobId", async (req, reply) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return reply.code(404).send({ error: "job not found" });
  }
  return job;
});

fastify.get("/scrape", async () => {
  // Lightweight admin/debug view of recent jobs. Strips heavy fields so the
  // listing stays small even after many scrapes.
  const jobs = listJobs().slice(0, 50).map((j) => ({
    jobId: j.jobId,
    status: j.status,
    query: j.query,
    maxPages: j.maxPages,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    error: j.error,
    resultCount: j.result?.results.length,
  }));
  return { jobs };
});

fastify.post<{ Body: { url?: string; full?: boolean } }>("/lighthouse", async (req, reply) => {
  const url = req.body?.url?.trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return reply.code(400).send({ error: "missing or invalid 'url' in body" });
  }
  try {
    const { id, reportPath, summary, lhr } = await runLighthouse(url);
    if (req.body?.full) {
      return { id, url, reportPath, summary, lhr };
    }
    return { id, url, reportPath, summary };
  } catch (err) {
    req.log.error({ err }, "lighthouse failed");
    return reply.code(500).send({ error: (err as Error).message });
  } finally {
    await closeOpenedPages();
  }
});

const port = Number(process.env.PORT ?? 3000);
fastify
  .listen({ port, host: "0.0.0.0" })
  .then(() => fastify.log.info(`API ready on :${port}`))
  .catch((err) => {
    fastify.log.error(err);
    process.exit(1);
  });
