import { chromium, type Browser, type Page } from "playwright";
import type { LsegConfig } from "../config.js";
import type { RunLogger } from "../io/runLogger.js";
import type { BrowserSession } from "./types.js";
import { ensureUsableViewport } from "./viewport.js";

export async function openBrowserSession(config: LsegConfig, logger: RunLogger): Promise<BrowserSession> {
  let browser: Browser | undefined;

  if (config.cdp_endpoint.trim()) {
    try {
      browser = await chromium.connectOverCDP(config.cdp_endpoint);
      await logger.event("INFO", "Connected browser over CDP", { cdpEndpoint: config.cdp_endpoint });
    } catch (error) {
      await logger.event("WARN", "CDP connect failed, launching fallback browser", { error: String(error) });
    }
  }

  if (!browser) {
    browser = await chromium.launch({
      channel: config.browser.fallback_channel,
      headless: config.browser.headless,
      slowMo: config.browser.slow_mo_ms
    });
    await logger.event("INFO", "Launched fallback browser");
  }

  const context = browser.contexts()[0] ?? (await browser.newContext({ acceptDownloads: true }));
  context.setDefaultTimeout(config.timeouts.default_ms);

  let page = findWorkspacePage(context.pages());
  if (!page) {
    page = await context.newPage();
    await page.goto(config.workspace_url, { waitUntil: "domcontentloaded" });
  }

  await ensureUsableViewport(page, logger);

  return { browser, context, page };
}

function findWorkspacePage(pages: Page[]): Page | undefined {
  const ranked = pages
    .map((page) => ({ page, rank: workspacePageRank(page.url(), page.frames().map((frame) => frame.url())) }))
    .filter((candidate) => candidate.rank > 0)
    .sort((a, b) => b.rank - a.rank);
  return ranked[0]?.page;
}

export function workspacePageRank(pageUrl: string, frameUrls: string[] = []): number {
  const urls = [pageUrl, ...frameUrls];
  if (urls.some((url) => /\/Apps\/research-next\/2\./i.test(url))) {
    return 4;
  }
  if (/\/web\/Apps\/research-next\//i.test(pageUrl)) {
    return 3;
  }
  if (/BatchSavePrint/i.test(pageUrl)) {
    return 0;
  }
  if (pageUrl.includes("workspace.refinitiv.com")) {
    return 1;
  }
  return 0;
}
