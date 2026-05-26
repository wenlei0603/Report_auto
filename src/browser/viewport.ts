import type { Page } from "playwright";
import type { RunLogger } from "../io/runLogger.js";

const MIN_VIEWPORT = { width: 1600, height: 1000 };

export interface ViewportSize {
  width: number;
  height: number;
}

export function needsViewportExpansion(size: ViewportSize, minimum: ViewportSize = MIN_VIEWPORT): boolean {
  return size.width < minimum.width || size.height < minimum.height;
}

export function targetViewportSize(size: ViewportSize, minimum: ViewportSize = MIN_VIEWPORT): ViewportSize {
  return {
    width: Math.max(size.width, minimum.width),
    height: Math.max(size.height, minimum.height)
  };
}

export async function ensureUsableViewport(page: Page, logger?: RunLogger): Promise<void> {
  await page.bringToFront().catch(() => undefined);

  const viewport = page.viewportSize();
  const inner = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => null);
  const current = inner ?? viewport;
  if (!current || !needsViewportExpansion(current)) {
    return;
  }

  const target = targetViewportSize(current);
  await page.setViewportSize(target).catch(() => undefined);

  let usedCdpWindowResize = false;
  try {
    const session = await page.context().newCDPSession(page);
    const windowInfo = await session.send("Browser.getWindowForTarget");
    try {
      await session.send("Browser.setWindowBounds", {
        windowId: windowInfo.windowId,
        bounds: { windowState: "normal", width: target.width, height: target.height }
      });
      usedCdpWindowResize = true;
    } catch {
      // Fall through to maximize below.
    }
    try {
      await session.send("Browser.setWindowBounds", {
        windowId: windowInfo.windowId,
        bounds: { windowState: "maximized" }
      });
      usedCdpWindowResize = true;
    } catch {
      // Some platforms do not accept maximize; viewport emulation above still helps.
    }
    await session.detach().catch(() => undefined);
  } catch {
    // Some attached contexts do not expose Browser.* CDP methods; viewportSize is still worth trying.
  }

  await page.setViewportSize(target).catch(() => undefined);

  await logger?.event("INFO", "Ensured usable browser viewport", { from: current, to: target, viewport, cdpWindowResize: usedCdpWindowResize });
}
