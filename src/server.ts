import Fastify from "fastify";
import { scrape } from "./scrape.ts";
import { closeOpenedPages, isReachable } from "./chrome.ts";
import { runLighthouse } from "./lighthouse.ts";

const fastify = Fastify({ logger: true });

fastify.get("/health", async () => {
  const chromeConnected = await isReachable();
  return { ok: true, chromeConnected };
});

fastify.post<{ Body: { query?: string; maxPages?: number } }>("/scrape", async (req, reply) => {
  const query = req.body?.query?.trim();
  if (!query) {
    return reply.code(400).send({ error: "missing 'query' in body" });
  }
  const maxPages = Math.max(1, Math.min(10, req.body?.maxPages ?? 5));
  try {
    const result = await scrape(query, maxPages);
    return result;
  } catch (err) {
    req.log.error({ err }, "scrape failed");
    return reply.code(500).send({ error: (err as Error).message });
  }
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
