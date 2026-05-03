import type { Frame, Page } from "playwright";
import type { LsegConfig } from "../config.js";
import type { RunLogger } from "../io/runLogger.js";
import type { AutomationScope } from "./types.js";

export function owningPage(scope: AutomationScope): Page {
  if ("page" in scope && typeof (scope as Frame).page === "function") {
    return (scope as Frame).page();
  }
  return scope as Page;
}

export function scopeUrl(scope: AutomationScope): string {
  return scope.url();
}

export function getResearchScope(page: Page): AutomationScope {
  const researchFrame = page.frames().find((frame) => /\/Apps\/research-next\/2\./.test(frame.url()));
  return researchFrame ?? page;
}

export async function waitForResearchScope(
  page: Page,
  config: LsegConfig,
  logger: RunLogger
): Promise<AutomationScope> {
  const deadline = Date.now() + config.timeouts.login_wait_seconds * 1000;
  let restarts = 0;

  while (Date.now() < deadline) {
    const scope = getResearchScope(page);
    const url = scopeUrl(scope);
    if (/\/Apps\/research-next\/2\./.test(url)) {
      return scope;
    }

    if (page.url().includes("BatchSavePrint") && config.behavior.recover_from_batchsaveprint) {
      await logger.event("WARN", "Recovering from BatchSavePrint page", { currentUrl: page.url() });
      await page.goto(config.workspace_url, { waitUntil: "domcontentloaded" });
    } else if (restarts < config.behavior.app_restart_attempts && hasLoadFailureText(await safeBodyText(scope))) {
      restarts += 1;
      await logger.event("WARN", "Research app appears failed, reloading workspace", { attempt: restarts });
      await page.goto(config.workspace_url, { waitUntil: "domcontentloaded" });
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`Research scope not ready after ${config.timeouts.login_wait_seconds}s; current URL=${page.url()}`);
}

async function safeBodyText(scope: AutomationScope): Promise<string> {
  try {
    return await scope.evaluate(() => document.body?.innerText ?? "");
  } catch {
    return "";
  }
}

function hasLoadFailureText(text: string): boolean {
  return /something went wrong|failed to load|try again|not available/i.test(text);
}
