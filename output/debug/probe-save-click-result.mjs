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

const selectAll = frame.locator("coral-checkbox.select-doc-checkbox").first();
const tooltip = await selectAll.evaluate((el) => el.getAttribute("tooltip") ?? "").catch(() => "");
const selected = Number.parseInt(tooltip.match(/(\d+)\s*Checked/i)?.[1] ?? "0", 10);
if (!(Number.isFinite(selected) && selected > 0)) {
  await selectAll.click({ timeout: 2500 }).catch(() => undefined);
  await page.waitForTimeout(300);
}

const downloadBtn = frame
  .locator("app-button:has-text('Download'), coral-button:has-text('Download'), app-button:has-text('DOWNLOAD'), coral-button:has-text('DOWNLOAD')")
  .first();
await downloadBtn.click({ timeout: 3000 }).catch(() => undefined);
await page.waitForTimeout(400);

const saveBtn = frame
  .locator(
    "app-button:has-text('Save Documents to PC'), coral-button:has-text('Save Documents to PC'), button:has-text('Save Documents to PC')"
  )
  .first();
const saveVisible = await saveBtn.isVisible({ timeout: 1500 }).catch(() => false);
if (saveVisible) {
  await saveBtn.click({ timeout: 3000 }).catch(() => undefined);
}

const trace = [];
for (let i = 0; i < 30; i += 1) {
  await page.waitForTimeout(1000);
  const pageStates = context.pages().map((p) => ({
    url: p.url()
  }));
  trace.push({
    sec: i + 1,
    currentPageUrl: page.url(),
    frameUrl: frame.url(),
    pages: pageStates
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      saveVisible,
      trace
    },
    null,
    2
  )
);

await browser.close();
