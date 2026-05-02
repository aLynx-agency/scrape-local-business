// Quick CDP smoke test: connects, opens a tab, navigates, prints title, closes.
import { connect, isReachable } from "./chrome.ts";

async function main() {
  if (!(await isReachable())) {
    console.error("Chrome CDP not reachable. Run `npm run chrome` first.");
    process.exit(1);
  }
  const { context } = await connect();
  const page = await context.newPage();
  try {
    await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
    const title = await page.title();
    console.log(`OK — page title: "${title}"`);
  } finally {
    await page.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
