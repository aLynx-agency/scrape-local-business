// Click the first card and dump the side panel that appears, looking for a
// website URL we can extract.
import { connect } from "./chrome.ts";

async function main() {
  const { context } = await connect();
  const page = await context.newPage();
  try {
    await page.goto(
      "https://www.google.com/search?q=" + encodeURIComponent("car dealer Brussels") + "&udm=1&hl=en",
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForSelector("div.VkpGBb", { timeout: 15_000 });
    await page.waitForTimeout(1500);

    // Click first card via the role="button" element inside it
    await page.evaluate(() => {
      const card = document.querySelector("div.VkpGBb");
      const btn = card?.querySelector('[role="button"][jsaction]');
      if (btn) (btn as HTMLElement).click();
    });

    await page.waitForTimeout(2500);

    const info = await page.evaluate(() => {
      // The side panel typically opens as an overlay. Look for any anchor on the
      // page that points to an external website (excluding google.com itself).
      const externalAnchors = Array.from(document.querySelectorAll("a[href^='http']")).filter((a) => {
        const href = (a as HTMLAnchorElement).href;
        return !href.includes("google.com") && !href.includes("googleadservices");
      });

      const sample = externalAnchors.slice(0, 10).map((a) => ({
        text: (a.textContent ?? "").trim().slice(0, 30),
        cls: a.getAttribute("class")?.slice(0, 60) ?? null,
        href: (a as HTMLAnchorElement).href.slice(0, 80),
        ariaLabel: a.getAttribute("aria-label"),
        dataAttrId: a.getAttribute("data-attrid") ?? a.getAttribute("data-pid"),
      }));

      // Also try looking specifically inside an open panel container
      const panel =
        document.querySelector('[role="dialog"]') ??
        document.querySelector('[aria-label][jscontroller][role]') ??
        null;

      return {
        externalAnchorCount: externalAnchors.length,
        sample,
        panelFound: !!panel,
        panelClass: panel?.getAttribute("class")?.slice(0, 80) ?? null,
      };
    });

    console.log(JSON.stringify(info, null, 2));
  } finally {
    await page.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
