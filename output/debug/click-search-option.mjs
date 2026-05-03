import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const configRaw = readFileSync("config/lseg.yaml", "utf8");
const config = parse(configRaw);
const selectors = config?.selectors?.modify_query_buttons ?? [];

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page =
  context?.pages().find((p) => p.url().includes("workspace.refinitiv.com") || p.url().includes("research-next")) ?? null;

if (!page) {
  console.log(JSON.stringify({ ok: false, reason: "workspace_page_not_found" }, null, 2));
  await browser.close();
  process.exit(0);
}

const frame = page.frames().find((f) => /\/Apps\/research-next\/2\./.test(f.url())) ?? page.mainFrame();

const panelVisible = async () =>
  frame.evaluate(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
    };
    return [...document.querySelectorAll(".top-filters-panel.active, coral-panel.filters-view .top-filters-panel.active")].some(visible);
  });

const companyInputVisible = async () =>
  frame.evaluate(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
    };
    const direct = document.querySelector("app-companies-filter emerald-multi-select input[placeholder*='Search by company' i]");
    if (direct && visible(direct)) return true;
    const host = document.querySelector("app-companies-filter emerald-multi-select");
    return Boolean(host && visible(host));
  });

const before = {
  panelVisible: await panelVisible(),
  companyInputVisible: await companyInputVisible()
};

let clickedBy = null;
for (const selector of selectors) {
  const candidates = frame.locator(selector);
  let count = 0;
  try {
    count = Math.min(await candidates.count(), 20);
  } catch {
    continue;
  }
  for (let i = 0; i < count; i += 1) {
    const item = candidates.nth(i);
    try {
      if (!(await item.isVisible({ timeout: 900 }))) continue;
      await item.scrollIntoViewIfNeeded({ timeout: 900 }).catch(() => undefined);
      await item.click({ timeout: 2200 });
      clickedBy = `${selector} [${i}]`;
      break;
    } catch {
      continue;
    }
  }
  if (clickedBy) break;
}

if (!clickedBy) {
  const fallback = await frame.evaluate(() => {
    const selectors = [
      "app-filters-label app-icon.edit-icon",
      "app-filters-label .edit-icon",
      "app-filters-label coral-icon[icon='edit']",
      ".additional-label-content app-icon.edit-icon",
      ".additional-label-content .edit-icon",
      "app-icon.edit-icon",
      "app-icon.edit-icon[tooltip='Search options']",
      "app-button.edit-filters-button",
      "app-button[tooltip='Search options']",
      "app-button[pi-button-name='FilterIconClick']",
      "app-button.edit-filters-button coral-button[icon='filter']",
      "coral-icon[icon='edit']"
    ];
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
    };
    for (const selector of selectors) {
      for (const el of [...document.querySelectorAll(selector)]) {
        if (!visible(el)) continue;
        const clickable = el.closest("app-button, app-icon, coral-button, button, [role='button'], .edit-icon") ?? el;
        if (clickable instanceof HTMLElement) {
          clickable.click();
          return selector;
        }
      }
    }
    return "";
  });
  if (fallback) clickedBy = `fallback:${fallback}`;
}

await page.waitForTimeout(800);
const after = {
  panelVisible: await panelVisible(),
  companyInputVisible: await companyInputVisible()
};

console.log(
  JSON.stringify(
    {
      ok: Boolean(clickedBy),
      clickedBy,
      before,
      after,
      pageUrl: page.url(),
      frameUrl: frame.url()
    },
    null,
    2
  )
);

await browser.close();
