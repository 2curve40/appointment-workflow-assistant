import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";

type ReadinessSample = {
  atMs: number;
  documentReadyState: string;
  networkIdleMs: number;
  iframesLoaded: boolean;
  continueVisible: boolean;
  continueEnabled: boolean;
  checkboxVisible: boolean;
  checkboxEnabled: boolean;
  hasLoadingElement: boolean;
  elementCount: number;
  failedChecks: string[];
};

const DEFAULT_URL = "https://transaction.bochk.com/whk/form/openAccount/input.action?lang=zh_HK";
const outputDir = resolve("debug/readiness");
const sampleIntervalMs = 500;
const requiredStableCycles = 3;
const maxWaitMs = 30000;
const minimumNetworkIdleMs = 1000;

async function main(): Promise<void> {
  const url = process.argv[2] || DEFAULT_URL;
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1365, height: 900 }
  });

  let lastNetworkActivityAt = Date.now();
  page.on("request", () => {
    lastNetworkActivityAt = Date.now();
  });
  page.on("requestfinished", () => {
    lastNetworkActivityAt = Date.now();
  });
  page.on("requestfailed", () => {
    lastNetworkActivityAt = Date.now();
  });

  try {
    const startedAt = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    const timeline: ReadinessSample[] = [];
    let stableCycles = 0;
    let lastElementCount: number | undefined;
    let ready = false;

    while (Date.now() - startedAt <= maxWaitMs) {
      const sample = await collectSample(page, startedAt, lastNetworkActivityAt, lastElementCount);
      timeline.push(sample);

      if (sample.failedChecks.length === 0) {
        stableCycles += 1;
      } else {
        stableCycles = 0;
      }
      lastElementCount = sample.elementCount;

      if (stableCycles >= requiredStableCycles) {
        ready = true;
        break;
      }

      await page.waitForTimeout(sampleIntervalMs);
    }

    const finalSample = timeline[timeline.length - 1];
    const result = {
      ready,
      stableCycles,
      totalWaitMs: Date.now() - startedAt,
      failedChecks: finalSample?.failedChecks ?? ["NO_SAMPLE"],
      timeline
    };
    const timelinePath = resolve(outputDir, `readiness-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await writeFile(timelinePath, `${JSON.stringify(result, null, 2)}\n`);

    console.log(JSON.stringify({
      ready: result.ready,
      stableCycles: result.stableCycles,
      totalWaitMs: result.totalWaitMs,
      failedChecks: result.failedChecks
    }, null, 2));
  } finally {
    await browser.close();
  }
}

async function collectSample(page: Page, startedAt: number, lastNetworkActivityAt: number, previousElementCount: number | undefined): Promise<ReadinessSample> {
  const now = Date.now();
  const documentReadyState = await page.evaluate(() => document.readyState).catch(() => "unknown");
  const networkIdleMs = now - lastNetworkActivityAt;
  const iframesLoaded = await areIframesLoaded(page);
  const continueState = await elementState(page, [
    "button",
    "input[type='button']",
    "input[type='submit']",
    "a"
  ], /(下一步|下 ?一 ?步|繼續|继续|continue|next)/i);
  const checkboxState = await checkboxReadiness(page);
  const hasLoadingElement = await page.locator("[aria-busy='true'], .loading, .loader, .spinner, [class*='loading'], [id*='loading']").count()
    .then((count) => count > 0)
    .catch(() => false);
  const elementCount = await page.locator("body *").count().catch(() => 0);
  const failedChecks: string[] = [];

  if (documentReadyState !== "complete") failedChecks.push("DOCUMENT_NOT_COMPLETE");
  if (networkIdleMs < minimumNetworkIdleMs) failedChecks.push("NETWORK_NOT_IDLE");
  if (!iframesLoaded) failedChecks.push("IFRAME_NOT_LOADED");
  if (!continueState.visible) failedChecks.push("CONTINUE_NOT_VISIBLE");
  if (!continueState.enabled) failedChecks.push("CONTINUE_NOT_ENABLED");
  if (!checkboxState.visible) failedChecks.push("CHECKBOX_NOT_VISIBLE");
  if (!checkboxState.enabled) failedChecks.push("CHECKBOX_NOT_ENABLED");
  if (hasLoadingElement) failedChecks.push("LOADING_ELEMENT_PRESENT");
  if (previousElementCount !== undefined && Math.abs(elementCount - previousElementCount) > 2) {
    failedChecks.push("ELEMENT_COUNT_UNSTABLE");
  }

  return {
    atMs: now - startedAt,
    documentReadyState,
    networkIdleMs,
    iframesLoaded,
    continueVisible: continueState.visible,
    continueEnabled: continueState.enabled,
    checkboxVisible: checkboxState.visible,
    checkboxEnabled: checkboxState.enabled,
    hasLoadingElement,
    elementCount,
    failedChecks
  };
}

async function areIframesLoaded(page: Page): Promise<boolean> {
  const frames = page.frames().slice(1);
  if (frames.length === 0) return true;
  const states = await Promise.all(frames.map((frame) =>
    frame.evaluate(() => document.readyState).then((state) => state === "complete").catch(() => false)
  ));
  return states.every(Boolean);
}

async function elementState(page: Page, selectors: string[], textPattern: RegExp): Promise<{ visible: boolean; enabled: boolean }> {
  for (const frame of page.frames()) {
    const state = await frame.locator(selectors.join(",")).evaluateAll((nodes, patternSource) => {
      const pattern = new RegExp(patternSource, "i");
      for (const node of nodes) {
        const element = node as HTMLElement & { disabled?: boolean; value?: string };
        const text = `${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("value") || ""} ${element.getAttribute("title") || ""}`;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        if (pattern.test(text) && visible) {
          return {
            visible: true,
            enabled: !element.disabled && element.getAttribute("aria-disabled") !== "true"
          };
        }
      }
      return { visible: false, enabled: false };
    }, textPattern.source).catch(() => ({ visible: false, enabled: false }));
    if (state.visible) return state;
  }
  return { visible: false, enabled: false };
}

async function checkboxReadiness(page: Page): Promise<{ visible: boolean; enabled: boolean }> {
  for (const frame of page.frames()) {
    const state = await frame.locator("input[type='checkbox']").evaluateAll((nodes) => {
      for (const node of nodes) {
        const element = node as HTMLInputElement;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        if (visible) {
          return {
            visible: true,
            enabled: !element.disabled && element.getAttribute("aria-disabled") !== "true"
          };
        }
      }
      return { visible: false, enabled: false };
    }).catch(() => ({ visible: false, enabled: false }));
    if (state.visible) return state;
  }
  return { visible: false, enabled: false };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
