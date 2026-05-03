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

const selectors = {
  selectAll: "coral-checkbox.select-doc-checkbox",
  download:
    "app-button:has-text('DOWNLOAD'), coral-button:has-text('DOWNLOAD'), app-button:has-text('Download'), coral-button:has-text('Download')",
  save: "button:has-text('SAVE DOCUMENTS TO PC'), button:has-text('Save Documents to PC'), button:has-text('Save to my PC')"
};

const before = await frame
  .locator(selectors.selectAll)
  .first()
  .evaluate((el) => ({ tooltip: el.getAttribute("tooltip") ?? "", html: el.outerHTML.slice(0, 180) }))
  .catch(() => ({ tooltip: "", html: "" }));

let selectedClicked = false;
const beforeSelectedCount = Number.parseInt((before.tooltip.match(/(\d+)\s*Checked/i)?.[1] ?? "0"), 10);
if (!(Number.isFinite(beforeSelectedCount) && beforeSelectedCount > 0)) {
  try {
    await frame.locator(selectors.selectAll).first().click({ timeout: 2500 });
    selectedClicked = true;
  } catch {
    selectedClicked = false;
  }
  await page.waitForTimeout(300);
}

const afterSelect = await frame
  .locator(selectors.selectAll)
  .first()
  .evaluate((el) => ({ tooltip: el.getAttribute("tooltip") ?? "" }))
  .catch(() => ({ tooltip: "" }));

let clickedDownload = false;
try {
  await frame.locator(selectors.download).first().click({ timeout: 3000 });
  clickedDownload = true;
} catch {
  clickedDownload = false;
}

const poll = [];
for (let i = 0; i < 10; i += 1) {
  await page.waitForTimeout(500);
  const saveCount = await frame.locator(selectors.save).count().catch(() => 0);
  const urls = context.pages().map((p) => p.url());
  poll.push({
    step: i + 1,
    pageUrl: page.url(),
    frameUrl: frame.url(),
    saveCount,
    urls
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      before,
      selectedClicked,
      afterSelect,
      clickedDownload,
      poll
    },
    null,
    2
  )
);

await browser.close();
