import type { Locator } from "playwright";
import type { AutomationScope } from "./types.js";

export async function firstVisible(scope: AutomationScope, selectors: string[], timeout = 800): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible({ timeout }))) {
        return locator;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function clickFirst(scope: AutomationScope, selectors: string[], timeout = 1000): Promise<boolean> {
  for (const selector of selectors) {
    const locators = scope.locator(selector);
    let count = 0;
    try {
      count = Math.min(await locators.count(), 25);
    } catch {
      continue;
    }
    for (let i = 0; i < count; i += 1) {
      const candidate = locators.nth(i);
      try {
        if (!(await candidate.isVisible({ timeout }))) {
          continue;
        }
        await candidate.scrollIntoViewIfNeeded({ timeout }).catch(() => undefined);
        await candidate.click({ timeout: Math.max(timeout, 3000) });
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

export async function anyVisible(scope: AutomationScope, selectors: string[], timeout = 500): Promise<boolean> {
  return (await firstVisible(scope, selectors, timeout)) !== null;
}

export async function countFirst(scope: AutomationScope, selectors: string[]): Promise<number> {
  for (const selector of selectors) {
    try {
      const count = await scope.locator(selector).count();
      if (count > 0) {
        return count;
      }
    } catch {
      continue;
    }
  }
  return 0;
}

export async function textFromFirst(scope: AutomationScope, selectors: string[]): Promise<string> {
  const locator = await firstVisible(scope, selectors, 500);
  if (!locator) {
    return "";
  }
  try {
    return (await locator.innerText({ timeout: 500 })).trim();
  } catch {
    return "";
  }
}
