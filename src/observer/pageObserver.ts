import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Frame, type Page } from "playwright";

type PageType = "MAINTENANCE" | "CAPTCHA" | "FORM" | "UNKNOWN";
type MetadataGroup = "GROUP_A" | "GROUP_B" | "GROUP_C" | "GROUP_D" | "GROUP_E" | "ACTION_A" | "UNKNOWN";
type FieldInfo = {
  frameIndex: number;
  frameUrl: string;
  tag: string;
  name: string;
  id: string;
  type: string;
  placeholder: string;
  text: string;
  disabled: boolean;
  readonly: boolean;
  visible: boolean;
};

type TextElementInfo = {
  frameIndex: number;
  frameUrl: string;
  tag: string;
  id: string;
  name: string;
  type: string;
  placeholder: string;
  text: string;
  disabled: boolean;
  readonly: boolean;
  visible: boolean;
};

const DEFAULT_URL = "https://transaction.bochk.com/whk/form/openAccount/input.action?lang=zh_HK";
const outputDir = resolve("debug/page-observer");

async function main(): Promise<void> {
  const url = process.argv[2] || DEFAULT_URL;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1365, height: 900 }
  });

  try {
    await mkdir(outputDir, { recursive: true });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(2000);

    const title = await page.title().catch(() => "");
    const currentUrl = page.url();
    const visibleText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const html = await page.content().catch(() => "");
    const iframeInfo = page.frames().slice(1).map((frame, index) => ({
      index,
      name: frame.name(),
      url: frame.url()
    }));
    const pageType = await classifyPage(page, title, currentUrl, visibleText, iframeInfo.map((frame) => frame.url));
    const formDiagnostics = await collectFormDiagnostics(page);
    const metadataSummary = createMetadataSummary(formDiagnostics);

    const screenshotPath = resolve(outputDir, `page-${stamp}.png`);
    const htmlPath = resolve(outputDir, `page-${stamp}.html`);
    const textPath = resolve(outputDir, `page-${stamp}.txt`);
    const iframePath = resolve(outputDir, `iframes-${stamp}.json`);
    const diagnosticsPath = resolve(outputDir, `form-diagnostics-${stamp}.json`);
    const metadataSummaryPath = resolve(outputDir, `metadata-summary-${stamp}.json`);
    const summaryPath = resolve(outputDir, `summary-${stamp}.json`);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    await writeFile(htmlPath, html);
    await writeFile(textPath, visibleText);
    await writeFile(iframePath, `${JSON.stringify(iframeInfo, null, 2)}\n`);
    await writeFile(diagnosticsPath, `${JSON.stringify(formDiagnostics, null, 2)}\n`);
    await writeFile(metadataSummaryPath, `${JSON.stringify(metadataSummary, null, 2)}\n`);
    await writeFile(summaryPath, `${JSON.stringify({
      pageType,
      title,
      url: currentUrl,
      screenshotPath,
      htmlPath,
      textPath,
      iframePath,
      diagnosticsPath,
      metadataSummaryPath,
      observedAt: new Date().toISOString()
    }, null, 2)}\n`);

    console.log(`JSON 路径: ${metadataSummaryPath}`);
    console.log(`每个 group 数量统计: ${formatGroupCounts(metadataSummary.counts)}`);
    console.log(`UNKNOWN 数量: ${metadataSummary.counts.UNKNOWN}`);
  } finally {
    await browser.close();
  }
}

async function classifyPage(page: Page, title: string, url: string, visibleText: string, iframeUrls: string[]): Promise<PageType> {
  const haystack = `${title}\n${url}\n${visibleText}\n${iframeUrls.join("\n")}`.toLowerCase();
  if (/(maintenance|maintain|temporarily unavailable|service unavailable|系統維護|系统维护|暫停服務|暂停服务|維護中|维护中)/i.test(haystack)) {
    return "MAINTENANCE";
  }
  if (/(captcha|recaptcha|hcaptcha|驗證碼|验证码|verification code|security check)/i.test(haystack)) {
    return "CAPTCHA";
  }

  const formSignals = await page.locator("form,input,select,textarea,button").count().catch(() => 0);
  if (formSignals > 0 && /bochk|openaccount|input\.action|form/i.test(haystack)) {
    return "FORM";
  }

  return "UNKNOWN";
}

async function collectFormDiagnostics(page: Page): Promise<{
  textFields: FieldInfo[];
  dropdowns: FieldInfo[];
  actionElements: TextElementInfo[];
  textLabels: TextElementInfo[];
  embeddedFrames: Array<{ index: number; name: string; url: string }>;
  counts: { textFields: number; dropdowns: number; actionElements: number; textLabels: number; embeddedFrames: number };
  hasImageOrCodeField: boolean;
  hasContinueOrNextElement: boolean;
}> {
  const frames = page.frames();
  const textFields = (await collectFields(frames, "input,textarea")).map((field) => ({
    ...field,
    tag: field.tag || "input"
  }));
  const dropdowns = (await collectFields(frames, "select")).map((field) => ({
    ...field,
    tag: "select"
  }));
  const actionElements = await collectTextElements(frames, "button,input[type='button'],input[type='submit'],a");
  const textLabels = await collectTextElements(frames, "label");
  const embeddedFrames = frames.slice(1).map((frame, index) => ({
    index,
    name: frame.name(),
    url: frame.url()
  }));
  const structureText = JSON.stringify({ textFields, dropdowns, actionElements, textLabels, embeddedFrames }).toLowerCase();
  const hasImageOrCodeField = /(image|img|code|captcha|recaptcha|hcaptcha|驗證碼|验证码|security code|verification code)/i.test(structureText);
  const hasContinueOrNextElement = actionElements.some((element) =>
    /(下一步|下 ?一 ?步|繼續|继续|continue|next)/i.test(element.text)
  );

  return {
    textFields,
    dropdowns,
    actionElements,
    textLabels,
    embeddedFrames,
    counts: {
      textFields: textFields.length,
      dropdowns: dropdowns.length,
      actionElements: actionElements.length,
      textLabels: textLabels.length,
      embeddedFrames: embeddedFrames.length
    },
    hasImageOrCodeField,
    hasContinueOrNextElement
  };
}

async function collectFields(frames: Frame[], selector: string): Promise<FieldInfo[]> {
  const results: FieldInfo[] = [];
  for (const [frameIndex, frame] of frames.entries()) {
    const frameUrl = frame.url();
    const fields = await frame.locator(selector).evaluateAll((nodes) =>
      nodes.map((node) => {
        const element = node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          name: element.getAttribute("name") || "",
          id: element.id || "",
          type: element.getAttribute("type") || "",
          placeholder: element.getAttribute("placeholder") || "",
          text: (element.textContent || element.value || "").trim(),
          disabled: element.disabled,
          readonly: element.hasAttribute("readonly"),
          visible: style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0
        };
      })
    ).catch(() => []);

    results.push(...fields.map((field) => ({
      frameIndex,
      frameUrl,
      ...field
    })));
  }
  return results;
}

async function collectTextElements(frames: Frame[], selector: string): Promise<TextElementInfo[]> {
  const results: TextElementInfo[] = [];
  for (const [frameIndex, frame] of frames.entries()) {
    const frameUrl = frame.url();
    const elements = await frame.locator(selector).evaluateAll((nodes) =>
      nodes.map((node) => {
        const element = node as HTMLButtonElement | HTMLInputElement | HTMLLabelElement;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id || "",
          name: element.getAttribute("name") || "",
          type: element.getAttribute("type") || "",
          placeholder: element.getAttribute("placeholder") || "",
          text: ((element.textContent || "") || ("value" in element ? String(element.value || "") : "")).trim(),
          disabled: "disabled" in element ? Boolean(element.disabled) : false,
          readonly: element.hasAttribute("readonly"),
          visible: style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0
        };
      })
    ).catch(() => []);

    results.push(...elements.map((element) => ({
      frameIndex,
      frameUrl,
      ...element
    })));
  }
  return results;
}

function createMetadataSummary(formDiagnostics: Awaited<ReturnType<typeof collectFormDiagnostics>>): {
  elements: Array<{
    original: FieldInfo | TextElementInfo;
    inferredGroup: MetadataGroup;
    confidence: number;
  }>;
  counts: Record<MetadataGroup, number>;
} {
  const elements = [
    ...formDiagnostics.textFields,
    ...formDiagnostics.dropdowns,
    ...formDiagnostics.actionElements,
    ...formDiagnostics.textLabels
  ].map((element) => {
    const inferred = inferMetadataGroup(element);
    return {
      original: element,
      inferredGroup: inferred.inferredGroup,
      confidence: inferred.confidence
    };
  });
  const counts = initialGroupCounts();
  for (const element of elements) {
    counts[element.inferredGroup] += 1;
  }
  return { elements, counts };
}

function inferMetadataGroup(element: FieldInfo | TextElementInfo): { inferredGroup: MetadataGroup; confidence: number } {
  const haystack = [
    element.name,
    element.id,
    element.type,
    element.placeholder,
    element.text,
    element.tag
  ].join(" ").toLowerCase();

  if (/(button|submit|下一步|下 ?一 ?步|繼續|继续|continue|next|confirm|submit)/i.test(haystack)) {
    return { inferredGroup: "ACTION_A", confidence: 0.86 };
  }
  if (/(code|captcha|verify|verification|otp|image|img|驗證碼|验证码)/i.test(haystack)) {
    return { inferredGroup: "GROUP_E", confidence: 0.82 };
  }
  if (/(date|day|month|year|日期|日|月|年)/i.test(haystack)) {
    return { inferredGroup: "GROUP_D", confidence: 0.78 };
  }
  if (/(district|branch|location|area|region|分行|地區|地区|網點|网点)/i.test(haystack)) {
    return { inferredGroup: "GROUP_C", confidence: 0.76 };
  }
  if (/(phone|mobile|tel|telephone|電話|电话|手機|手机)/i.test(haystack)) {
    return { inferredGroup: "GROUP_B", confidence: 0.74 };
  }
  if (/(name|first|last|surname|given|姓名|姓|名|email|mail|電郵|电邮)/i.test(haystack)) {
    return { inferredGroup: "GROUP_A", confidence: 0.72 };
  }
  return { inferredGroup: "UNKNOWN", confidence: 0.2 };
}

function initialGroupCounts(): Record<MetadataGroup, number> {
  return {
    GROUP_A: 0,
    GROUP_B: 0,
    GROUP_C: 0,
    GROUP_D: 0,
    GROUP_E: 0,
    ACTION_A: 0,
    UNKNOWN: 0
  };
}

function formatGroupCounts(counts: Record<MetadataGroup, number>): string {
  return Object.entries(counts).map(([group, count]) => `${group}=${count}`).join(" ");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
