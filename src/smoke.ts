// Quick smoke test: launches patchright, opens a tab, navigates, prints title.
import { connect } from "./chrome.ts";

async function main() {
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
