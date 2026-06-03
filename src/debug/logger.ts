import { appendFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "playwright";

const DEBUG_DIR = resolve("debug");
const RUN_LOG = resolve(DEBUG_DIR, "run.log");

export type DebugKind = "STEP" | "URL" | "SELECTOR" | "RESULT";

export class DebugLogger {
  readonly taskId: string;
  readonly stamp: string;

  constructor(taskId: string) {
    this.taskId = taskId;
    this.stamp = fileStamp();
  }

  async init(): Promise<void> {
    await mkdir(DEBUG_DIR, { recursive: true });
  }

  async log(kind: DebugKind, message: string): Promise<void> {
    await this.init();
    const line = `[${new Date().toISOString()}] [${this.taskId}] [${kind}] ${message}`;
    console.log(line);
    await appendFile(RUN_LOG, `${line}\n`);
  }

  async step(name: string, page?: Page): Promise<void> {
    await this.log("STEP", name);
    if (page) {
      await this.logUrl(page);
      await this.screenshot(page, "step", name);
      await this.slow();
    }
  }

  async selector(action: string, selector: string): Promise<void> {
    await this.log("SELECTOR", `${action}: ${selector}`);
  }

  async result(message: string): Promise<void> {
    await this.log("RESULT", message);
  }

  async logUrl(page: Page): Promise<void> {
    await this.log("URL", page.url());
  }

  async fail(page: Page, selector: string, reason: string): Promise<void> {
    await this.log("RESULT", `失败：${reason}`);
    await this.log("SELECTOR", `失败 selector: ${selector}`);
    await this.logUrl(page);
    await this.log("RESULT", `页面标题：${await page.title().catch(() => "无法读取标题")}`);
    await this.log("RESULT", `可见按钮：${(await visibleButtons(page)).join(" | ") || "无"}`);
    await this.log("RESULT", `可见表单：${JSON.stringify(await visibleFields(page))}`);
    await this.screenshot(page, "fail", "failure");
  }

  async screenshot(page: Page, kind: "step" | "fail", name: string): Promise<string | undefined> {
    await this.init();
    const path = resolve(DEBUG_DIR, `${kind}-${this.taskId}-${sanitize(name)}-${fileStamp()}.png`);
    try {
      await page.screenshot({ path, fullPage: true });
      await this.log("RESULT", `${kind === "step" ? "步骤截图" : "失败截图"}：${path}`);
      return path;
    } catch (error) {
      await this.log("RESULT", `截图失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async diagnosePage(page: Page, reason: string): Promise<void> {
    await this.log("STEP", `页面结构诊断：${reason}`);
    await this.logUrl(page);
    const frames = page.frames();
    await this.log("RESULT", `是否存在 iframe：${frames.length > 1 ? "是" : "否"}`);
    await this.log("RESULT", `iframe 数量：${Math.max(0, frames.length - 1)}`);
    await this.log("RESULT", `iframe URL：${frames.slice(1).map((frame) => frame.url()).join(" | ") || "无"}`);
    await this.log("RESULT", `所有 button 文本：${(await allTexts(page, "button")).join(" | ") || "无"}`);
    await this.log("RESULT", `所有 a 文本：${(await allTexts(page, "a")).join(" | ") || "无"}`);
    await this.log("RESULT", `所有 input/select/textarea：${JSON.stringify(await allFields(page))}`);

    const textPath = resolve(DEBUG_DIR, `page-text-${this.taskId}-${fileStamp()}.txt`);
    const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    await writeFile(textPath, bodyText.slice(0, 3000));
    await this.log("RESULT", `页面 body 前 3000 字已保存：${textPath}`);
  }

  async slow(): Promise<void> {
    if (debugEnabled()) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    }
  }

  tracePath(): string {
    return resolve(DEBUG_DIR, `trace-${this.taskId}-${this.stamp}.zip`);
  }
}

export function debugEnabled(): boolean {
  return process.env.DEBUG_AUTOMATION === "1" || process.env.DEBUG_AUTOMATION === "true";
}

export function debugDirectory(): string {
  return DEBUG_DIR;
}

export async function ensureDebugDirectory(): Promise<void> {
  await mkdir(DEBUG_DIR, { recursive: true });
}

export async function cleanDebugDirectory(): Promise<void> {
  await ensureDebugDirectory();
  const entries = await readdir(DEBUG_DIR, { withFileTypes: true });
  await Promise.all(entries.map((entry) =>
    rm(resolve(DEBUG_DIR, entry.name), { recursive: true, force: true })
  ));
  const line = "[SYSTEM] Debug directory cleaned.";
  console.log(line);
  await appendFile(RUN_LOG, `${line}\n`);
}

export async function logSystemStateChange(oldStatus: string, newStatus: string): Promise<void> {
  await appendSystemLog(`[STATE] ${oldStatus} -> ${newStatus}`);
}

export async function logSystemSchedule(values: Record<string, string | boolean>): Promise<void> {
  await appendSystemLog(`[SCHEDULE] ${Object.entries(values).map(([key, value]) => `${key}=${value}`).join(" / ")}`);
}

export async function logSystemTask(message: string): Promise<void> {
  await appendSystemLog(`[TASK] ${message}`);
}

export async function logSystemDatePhase(values: Record<string, string | number>): Promise<void> {
  await appendSystemLog(`[DATE_PHASE] ${Object.entries(values).map(([key, value]) => `${key}=${value}`).join(" ")}`);
}

export async function logSystemAction(values: Record<string, string>): Promise<void> {
  await appendSystemLog(`[ACTION] ${Object.entries(values).map(([key, value]) => `${key}=${value}`).join(" ")}`);
}

async function appendSystemLog(line: string): Promise<void> {
  await ensureDebugDirectory();
  console.log(line);
  await appendFile(RUN_LOG, `${line}\n`);
}

function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitize(value: string): string {
  return value.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 60) || "step";
}

async function visibleButtons(page: Page): Promise<string[]> {
  return page.locator("button:visible,input[type='button']:visible,input[type='submit']:visible").evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent || (node as HTMLInputElement).value || "").trim()).filter(Boolean).slice(0, 30)
  ).catch(() => []);
}

async function visibleFields(page: Page): Promise<Array<Record<string, string>>> {
  return page.locator("input:visible,select:visible,textarea:visible").evaluateAll((nodes) =>
    nodes.slice(0, 60).map((node) => {
      const element = node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      return {
        tag: element.tagName.toLowerCase(),
        name: element.getAttribute("name") || "",
        id: element.id || "",
        placeholder: element.getAttribute("placeholder") || "",
        type: element.getAttribute("type") || ""
      };
    })
  ).catch(() => []);
}

async function allTexts(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent || "").trim()).filter(Boolean).slice(0, 80)
  ).catch(() => []);
}

async function allFields(page: Page): Promise<Array<Record<string, string>>> {
  return page.locator("input,select,textarea").evaluateAll((nodes) =>
    nodes.slice(0, 120).map((node) => {
      const element = node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      return {
        tag: element.tagName.toLowerCase(),
        name: element.getAttribute("name") || "",
        id: element.id || "",
        placeholder: element.getAttribute("placeholder") || "",
        type: element.getAttribute("type") || ""
      };
    })
  ).catch(() => []);
}
