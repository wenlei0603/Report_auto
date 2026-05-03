import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page = context?.pages().find((p) => p.url().includes("workspace.refinitiv.com") || p.url().includes("research-next"));
if (!page) {
  console.log(JSON.stringify({ ok: false, reason: "workspace_page_not_found" }, null, 2));
  await browser.close();
  process.exit(0);
}
const frame = page.frames().find((f) => /\/Apps\/research-next\/2\./.test(f.url())) ?? page.mainFrame();

const selectors = [
  "table tbody tr",
  "[role='row']",
  "[role='rowgroup'] [role='row']",
  ".ag-row",
  ".rt-tr",
  ".data-grid-row",
  "[data-testid*='row' i]",
  "app-results-list tr",
  "tr"
];

const data = [];
for (const selector of selectors) {
  const loc = frame.locator(selector);
  let count = 0;
  try {
    count = await loc.count();
  } catch {
    count = -1;
  }
  const samples = [];
  if (count > 0) {
    for (let i = 0; i < Math.min(count, 12); i += 1) {
      try {
        const text = (await loc.nth(i).innerText({ timeout: 300 })).replace(/\s+/g, " ").trim();
        if (text) samples.push(text.slice(0, 240));
      } catch {
        // ignore
      }
    }
  }
  data.push({ selector, count, samples });
}

const pageTextSignals = await frame.evaluate(() => {
  const text = document.body?.innerText ?? "";
  const dateOnly = (text.match(/\b\d{1,2}-[A-Za-z]{3}-\d{4}\b/g) ?? []).length;
  const dateTime = (text.match(/\b\d{1,2}-[A-Za-z]{3}-\d{4},\s*\d{1,2}:\d{2}\b/g) ?? []).length;
  const noResults = /no\s+results/i.test(text);
  const hasDownloadWord = /\bdownload\b/i.test(text);
  return {
    textLength: text.length,
    dateOnly,
    dateTime,
    noResults,
    hasDownloadWord,
    preview: text.slice(0, 1200).replace(/\s+/g, " ")
  };
});

console.log(
  JSON.stringify(
    {
      ok: true,
      pageUrl: page.url(),
      frameUrl: frame.url(),
      data,
      pageTextSignals
    },
    null,
    2
  )
);

await browser.close();
