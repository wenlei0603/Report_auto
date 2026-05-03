import { chromium, type Browser, type Page } from "playwright";
import type { LsegConfig } from "../config.js";
import type { RunLogger } from "../io/runLogger.js";
import type { BrowserSession } from "./types.js";

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

  return { browser, context, page };
}

function findWorkspacePage(pages: Page[]): Page | undefined {
  return pages.find((page) => {
    const url = page.url();
    return url.includes("workspace.refinitiv.com") || url.includes("research-next") || url.includes("BatchSavePrint");
  });
}
