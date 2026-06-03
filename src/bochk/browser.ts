import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from "playwright";
import type { BookingRequest, BookingResult, BookingSuccessDetails, CustomerInfo, Slot, TaskStatus } from "../types.js";
import { bochkSelectors } from "./selectors.js";
import { DebugLogger, debugEnabled } from "../debug/logger.js";

const BOOKING_URL = "https://www.bochk.com/tc/contact/online/hkpaccountopen.html";

export type AppointmentPageType =
  | "CAPTCHA"
  | "SLOT_SELECTION"
  | "CUSTOMER_INFO"
  | "CONFIRMATION"
  | "SUCCESS"
  | "UNKNOWN";

type SubmitResultType = "SUCCESS" | "SLOT_FULL" | "VALIDATION_ERROR" | "CAPTCHA" | "TIMEOUT" | "UNKNOWN";
type TerminalPageType = "SUCCESS" | "TIMEOUT";
type SelectOptionSnapshot = {
  label: string;
  value: string;
  disabled: boolean;
};

type SlotAnalysis = {
  reachedSecondPage: boolean;
  availableDates: string[];
  availableSlots: Record<string, string[]>;
  requestedDate: string;
  requestedSlots: string[];
  matchedSlot: Slot | null;
  noMatchReason: string;
};

type HumanVerificationHooks = {
  onWaiting?: (message: string) => Promise<void>;
  onContinue?: (message: string) => Promise<void>;
  onStatus?: (status: TaskStatus, message: string) => Promise<void>;
  waitForResume?: (signal: AbortSignal) => Promise<void>;
};

type BochkAppointmentBotOptions = {
  singleScan?: boolean;
  manualScanWindowMs?: number;
  taskId?: string;
};

export class BochkAppointmentBot {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private lastStep = "未开始";
  private traceStopped = false;
  private latestSlot?: Slot;
  private manualScanDeadlineAt = 0;
  private noAvailableDateAttempts = 0;
  private thirdPageProcessed = false;
  private slotSelectionBlockedReason?: string;
  private stopManualScanAfterCurrentAttempt = false;
  private manualCaptchaInputAcknowledged = false;
  private slotSelectionModeOverride?: "date-first" | "branch-first";
  private lockedSlotSubmitAttempts = 0;
  private lockedDateForScan?: string;

  constructor(
    private readonly request: BookingRequest,
    private readonly logger = new DebugLogger("manual"),
    private readonly humanVerificationHooks: HumanVerificationHooks = {},
    private readonly options: BochkAppointmentBotOptions = {}
  ) {}

  async open(): Promise<void> {
    await this.logger.init();
    this.lastStep = "启动浏览器";
    await this.logger.step("打开页面：启动浏览器");
    this.browser = await chromium.launch({
      headless: this.request.runner.headless,
      slowMo: debugEnabled() ? 1000 : (this.request.runner.headless ? 0 : 80)
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1365, height: 900 },
      locale: "zh-HK"
    });
    await this.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    this.page = await this.context.newPage();
    await this.logger.selector("goto", BOOKING_URL);
    await this.page.goto(BOOKING_URL, { waitUntil: "domcontentloaded" });
    this.lastStep = `已打开 BOCHK 页面：${await this.page.title().catch(() => "")} ${this.page.url()}`;
    await this.logger.result(this.lastStep);
    await this.logger.step("打开页面完成", this.page);
  }

  async close(): Promise<void> {
    await this.saveTrace();
    await this.browser?.close();
  }

  async saveTrace(): Promise<void> {
    if (this.context && !this.traceStopped) {
      const tracePath = this.logger.tracePath();
      await this.context.tracing.stop({ path: tracePath }).catch(async (error) => {
        await this.logger.result(`Trace 保存失败：${error instanceof Error ? error.message : String(error)}`);
      });
      this.traceStopped = true;
      await this.logger.result(`Trace 已保存：${tracePath}`);
    }
  }

  async tryBookOnce(): Promise<BookingResult> {
    const page = this.requirePage();
    this.lastStep = "刷新 BOCHK 页面";
    await this.logger.step("打开页面：刷新 BOCHK 页面", page);
    await this.logger.selector("goto", BOOKING_URL);
    await page.goto(BOOKING_URL, { waitUntil: "domcontentloaded" });
    this.lastStep = `刷新后页面：${await page.title().catch(() => "")} ${page.url()}`;
    await this.logger.result(this.lastStep);

    if (await this.hasHumanVerification()) {
      this.lastStep = "遇到验证码/人机验证";
      await this.waitForHumanVerificationLoop("页面出现验证码或人机验证");
    }

    this.lastStep = "尝试进入预约流程";
    await this.logger.step("点击进入预约", page);
    await this.ensureAppointmentFrame();
    this.lastStep = `已进入预约页/iframe：${page.url()}`;
    await this.logger.result(this.lastStep);
    const initialBlock = await this.completeInitialAccountStep();
    if (initialBlock) {
      return initialBlock;
    }
    return this.runAppointmentStateMachine();
  }

  getLastStep(): string {
    return this.lastStep;
  }

  async prepareFirstPage(): Promise<BookingResult | undefined> {
    const page = this.requirePage();
    this.lastStep = "PREPARE_FIRST_PAGE：准备第一页";
    await this.logger.step("PREPARE_FIRST_PAGE", page);
    await this.ensureAppointmentFrame();
    return this.completeInitialAccountStep();
  }

  async prefillAfterCaptcha(): Promise<BookingResult | undefined> {
    const page = this.requirePage();
    this.lastStep = "PREFILL_AFTER_CAPTCHA：验证码后预填资料";
    await this.logger.step("PREFILL_AFTER_CAPTCHA", page);

    for (let iteration = 1; iteration <= 12; iteration += 1) {
      const pageType = await this.detectCurrentPageType();
      await this.logger.step(`PREFILL_AFTER_CAPTCHA 页面类型：${pageType}`, page);

      if (pageType === "CAPTCHA") {
        await this.waitForManualCaptcha();
        continue;
      }

      if (pageType === "CUSTOMER_INFO") {
        const humanBlock = await this.fillCustomerInfo();
        if (humanBlock) return humanBlock;
        return undefined;
      }

      if (pageType === "SLOT_SELECTION") {
        const humanBlock = await this.detectSecondPageHumanVerification();
        if (humanBlock) return humanBlock;
        await this.prefillSlotFilters();
        return undefined;
      }

      if (pageType === "CONFIRMATION" || pageType === "SUCCESS") {
        return undefined;
      }

      await this.saveFullDiagnosis(`prefill-unknown-${iteration}`);
      return { status: "needs-human", reason: "验证码后无法识别页面，已保存诊断并保留浏览器现场。" };
    }

    return { status: "needs-human", reason: "验证码后预填循环次数过多，已保存调试信息。" };
  }

  async scanReleaseOnce(): Promise<BookingResult> {
    const page = this.requirePage();
    const pageType = await this.detectCurrentPageType();
    this.lastStep = `RELEASE_SCAN：${pageType}`;
    await this.logger.step(`RELEASE_SCAN 页面类型：${pageType}`, page);

    if (pageType === "CAPTCHA") {
      await this.waitForManualCaptcha();
      return { status: "no-slot", reason: "验证码处理完成，继续扫描。" };
    }

    if (pageType === "SLOT_SELECTION") {
      const slot = await this.fillSlotSelection();
      if (!slot) {
        const blockedResult = this.slotSelectionBlockedResult();
        if (blockedResult) return blockedResult;
        return { status: "no-slot", reason: "当前没有符合条件的可预约时段。" };
      }
      this.latestSlot = slot;
      this.lockedSlotSubmitAttempts = 0;
      await this.logger.result(`已锁定号源：${slot.district ?? ""} ${slot.branch} ${slot.date} ${slot.time}`);
      await this.humanVerificationHooks.onStatus?.("slot-locked", `已锁定号源：${slot.district ?? ""} ${slot.branch} ${slot.date} ${slot.time}`);
      await this.clickContinueByText();
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(1000);
      return this.finishFromCurrentPage();
    }

    if (pageType === "CUSTOMER_INFO" || pageType === "CONFIRMATION" || pageType === "SUCCESS") {
      return this.finishFromCurrentPage();
    }

    await this.saveFullDiagnosis("release-scan-unknown");
    return { status: "needs-human", reason: "扫描时遇到未知页面，已保存诊断并保留浏览器现场。" };
  }

  async assistFillOnce(): Promise<BookingResult> {
    const page = this.requirePage();
    await this.logger.step("辅助填写：打开真实预约页", page);
    await page.goto(BOOKING_URL, { waitUntil: "domcontentloaded" });

    if (await this.hasHumanVerification()) {
      await this.waitForHumanVerificationLoop("页面出现验证码或人机验证");
    }

    await this.ensureAppointmentFrame();
    await this.logger.result(`辅助填写入口状态：${this.lastStep}`);
    const initialBlock = await this.completeInitialAccountStep();
    if (initialBlock) {
      return initialBlock;
    }
    return this.runAppointmentStateMachine();
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new Error("Browser is not open. Call open() before tryBookOnce().");
    }
    return this.page;
  }

  private async tryClickStartBooking(): Promise<void> {
    for (const selector of bochkSelectors.startBooking) {
      if (await this.clickIfVisible(selector)) {
        await this.requirePage().waitForLoadState("domcontentloaded").catch(() => undefined);
        return;
      }
    }
  }

  private async ensureAppointmentFrame(): Promise<void> {
    const page = this.requirePage();
    await this.logger.step("检测 iframe", page);
    if (await page.locator("#iframe").first().isVisible().catch(() => false)) {
      this.lastStep = "已在预约页面，检测到 BOCHK 预约 iframe";
      await this.logger.result(this.lastStep);
      return;
    }

    for (const selector of bochkSelectors.startBooking) {
      await this.logger.selector("等待/点击预约入口", selector);
      if (await this.clickIfVisible(selector)) {
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await page.locator("#iframe").first().waitFor({ state: "visible", timeout: 10000 }).catch(() => undefined);
        this.lastStep = `点击预约入口后页面：${await page.title().catch(() => "")} ${page.url()}`;
        await this.logger.result(this.lastStep);
        return;
      }
    }

    this.lastStep = `没有找到预约入口，当前页面：${await page.title().catch(() => "")} ${page.url()}`;
    await this.logger.diagnosePage(page, "点击进入预约失败");
  }

  private async completeInitialAccountStep(): Promise<BookingResult | undefined> {
    const hasInitialForm = await this.firstVisibleLocator(bochkSelectors.documentType);
    if (!hasInitialForm) {
      this.lastStep = "未检测到第一页证件/账户表单，继续检查后续预约字段";
      return undefined;
    }

    this.lastStep = "填写第一页：证件种类、账户种类、同意条款";
    await this.logger.step("进入第二页/第一页表单：填写证件账户信息", this.requirePage());
    const { customer } = this.request;
    const documentSelected = await this.selectOptionByValueOrLabel(
      bochkSelectors.documentType,
      documentTypeValue(customer.documentType),
      customer.documentType
    );
    const accountSelected = await this.selectOptionByValueOrLabel(
      bochkSelectors.accountType,
      accountTypeValue(customer.accountType),
      customer.accountType
    );
    const termsChecked = await this.checkIfVisible(bochkSelectors.acceptTerms);

    if (!documentSelected || !accountSelected || !termsChecked) {
      this.lastStep = `第一页未填完整：证件=${documentSelected ? "已选" : "未选"}，账户=${accountSelected ? "已选" : "未选"}，条款=${termsChecked ? "已勾" : "未勾"}`;
      return {
        status: "needs-human",
        reason: `${this.lastStep}。请在打开的浏览器中手动补齐后继续。`
      };
    }

    this.lastStep = "提交第一页并等待下一步表单";
    await this.logger.step("等待页面加载：提交第一页", this.requirePage());
    await this.clickIfVisible(bochkSelectors.submit);
    return this.waitForPostInitialAccountSubmit();
  }

  private async waitForPostInitialAccountSubmit(): Promise<BookingResult | undefined> {
    const page = this.requirePage();
    const deadline = Date.now() + 12_000;
    let lastPageType: AppointmentPageType = "UNKNOWN";
    let noticeContinueClicked = false;

    while (Date.now() < deadline) {
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(800);

      if (await this.hasHumanVerification()) {
        if (await this.hasCustomerInfoFields()) {
          this.lastStep = "第二页同时检测到客户资料字段和验证码，先填客户资料再等待人工验证";
          await this.logger.result(this.lastStep);
          return undefined;
        }
        this.lastStep = "第一页后遇到验证码/人机验证";
        await this.logger.result(this.lastStep);
        await this.waitForHumanVerificationLoop("第一页后出现验证码或人机验证");
        return undefined;
      }

      if (!noticeContinueClicked && await this.isInitialAccountNoticePage()) {
        noticeContinueClicked = true;
        this.lastStep = "第一页资料政策通知页，点击继续进入客户资料页";
        await this.logger.result(this.lastStep);
        await this.clickContinueByText();
        continue;
      }

      lastPageType = await this.detectCurrentPageType();
      if (lastPageType !== "UNKNOWN" && lastPageType !== "CAPTCHA") {
        this.lastStep = `第一页已提交，准备处理页面：${lastPageType}`;
        await this.logger.result(this.lastStep);
        return undefined;
      }

      if (!await this.hasVisibleLocator(bochkSelectors.documentType, 300)) {
        this.lastStep = "第一页已提交，证件/账户表单已消失";
        await this.logger.result(this.lastStep);
        return undefined;
      }
    }

    if (await this.hasHumanVerification()) {
      this.lastStep = "第一页后遇到验证码/人机验证";
      await this.logger.result(this.lastStep);
      await this.waitForHumanVerificationLoop("第一页后出现验证码或人机验证");
      return undefined;
    }

    this.lastStep = "第一页提交后仍停留在证件/账户页";
    await this.logger.result(`第一页提交等待超时，最后页面类型：${lastPageType}`);
    await this.logger.diagnosePage(page, "第二页卡住：提交第一页后仍停留在证件/账户页");
    return {
      status: "needs-human",
      reason: "第一页提交后仍停留在证件/账户页，可能有校验提示、预约码要求或页面脚本阻止继续，请人工检查。"
    };
  }

  private async findAndSelectSlot(): Promise<Slot | undefined> {
      const page = this.requirePage();
      await this.selectFirstMatchingOption(
        bochkSelectors.district,
      this.request.appointment.preferredDistricts,
      { skipFull: true }
    );
    await this.selectFirstMatchingOption(bochkSelectors.branch, this.request.appointment.preferredBranches);

    const dateSelected = await this.selectFirstMatchingDate(bochkSelectors.date);
    const timeSelected = await this.selectFirstMatchingTime(bochkSelectors.time);
    if (!dateSelected || !timeSelected) {
      return undefined;
    }

    return {
      branch: await this.selectedLabel(bochkSelectors.branch) ?? "未识别分行",
      district: await this.selectedLabel(bochkSelectors.district) ?? undefined,
      date: await this.selectedLabel(bochkSelectors.date) ?? dateSelected,
      time: await this.selectedLabel(bochkSelectors.time) ?? timeSelected
    };
  }

  private async runAppointmentStateMachine(): Promise<BookingResult> {
    let latestSlot: Slot | undefined;
    let submitRetries = 0;
    for (let iteration = 1; iteration <= 40; iteration += 1) {
      const page = this.requirePage();
      const pageType = await this.detectCurrentPageType();
      this.lastStep = `状态机第 ${iteration} 步：${pageType}`;
      await this.logger.step(`状态机识别页面：${pageType}`, page);
      await this.installManualOverrideDetector();

      const terminalResult = await this.finishTerminalPageIfPresent(latestSlot);
      if (terminalResult) {
        return terminalResult;
      }

      if (pageType === "SLOT_SELECTION" || pageType === "CUSTOMER_INFO" || pageType === "CONFIRMATION") {
        const manualOverride = await this.stopIfManualOverride();
        if (manualOverride) {
          return manualOverride;
        }
      }

      if (pageType === "CAPTCHA") {
        await this.waitForManualCaptcha();
        continue;
      }

      if (pageType === "SLOT_SELECTION") {
        this.lastStep = "自动选择地区/分行/日期/时间";
        await this.logger.step("选择地区/分行/日期/时间", page);
        latestSlot = await this.fillSlotSelectionWithinManualWindow("slot-selection");
        if (!latestSlot) {
          const blockedResult = this.slotSelectionBlockedResult();
          if (blockedResult) return blockedResult;
          await this.saveFullDiagnosis("slot-selection-no-slot");
          return { status: "no-slot", reason: "当前条件下没有可用时段，已保存页面诊断。" };
        }
        this.latestSlot = latestSlot;
        this.lockedSlotSubmitAttempts = 0;
        const lockedSubmitResult = await this.submitLockedSlotAndWait("选号页已锁定日期/时间/分行");
        if (lockedSubmitResult) return lockedSubmitResult;
        continue;
      }

      if (pageType === "CUSTOMER_INFO") {
        if (this.manualCaptchaInputAcknowledged && await this.hasSlotSelectionFields()) {
          if (this.latestSlot) {
            const lockedSubmitResult = await this.submitLockedSlotAndWait("验证码已处理且已有锁定号源");
            if (lockedSubmitResult) return lockedSubmitResult;
            continue;
          }
          await this.logger.result("验证码已人工处理，跳过重复填写客户资料，直接补齐地区/分行/日期/时间");
          latestSlot = await this.fillSlotSelectionWithinManualWindow("customer-info-slot-fields");
          if (!latestSlot) {
            const blockedResult = this.slotSelectionBlockedResult();
            if (blockedResult) return blockedResult;
            await this.saveFullDiagnosis("customer-info-no-slot");
            return { status: "no-slot", reason: "当前条件下没有可用时段，已保存页面诊断。" };
          }
          this.latestSlot = latestSlot;
          this.lockedSlotSubmitAttempts = 0;
          await this.logger.result(`已锁定号源：${latestSlot.district ?? ""} ${latestSlot.branch} ${latestSlot.date} ${latestSlot.time}`);
          await this.humanVerificationHooks.onStatus?.("slot-locked", `已锁定号源：${latestSlot.district ?? ""} ${latestSlot.branch} ${latestSlot.date} ${latestSlot.time}`);
          const lockedSubmitResult = await this.submitLockedSlotAndWait("验证码后补齐并锁定号源");
          if (lockedSubmitResult) return lockedSubmitResult;
          continue;
        }

        if (await this.isInitialAccountNoticePage()) {
          this.lastStep = "资料政策通知页仍未进入客户资料页，点击继续";
          await this.logger.result(this.lastStep);
          await this.clickContinueByText();
          await page.waitForLoadState("domcontentloaded").catch(() => undefined);
          await page.waitForTimeout(1200);
          continue;
        }
        this.lastStep = "自动填写客户资料页";
        await this.logger.step("填写客户资料", page);
        const humanBlock = await this.fillCustomerInfo();
        if (humanBlock) {
          return humanBlock;
        }
        if (await this.hasSlotSelectionFields()) {
          if (this.latestSlot) {
            if (await this.hasHumanVerification() && !this.manualCaptchaInputAcknowledged) {
              this.lastStep = "已有锁定号源，等待人工输入验证码后直接提交";
              await this.logger.result(`已有锁定号源，不再重新选择日期/时间/区域/分行，等待验证码后直接提交：${this.latestSlot.district ?? ""} ${this.latestSlot.branch} ${this.latestSlot.date} ${this.latestSlot.time}`);
              await this.waitForHumanVerificationLoop("已有锁定号源，等待人工验证码");
              await page.waitForLoadState("domcontentloaded").catch(() => undefined);
              await page.waitForTimeout(1000);
              continue;
            }
            const lockedSubmitResult = await this.submitLockedSlotAndWait("客户资料页已有锁定号源");
            if (lockedSubmitResult) return lockedSubmitResult;
            continue;
          }
          if (await this.hasHumanVerification() && !this.manualCaptchaInputAcknowledged) {
            this.lastStep = "客户资料已填写，等待人工输入验证码";
            await this.logger.result("客户资料页同时有验证码和预约必填项，先等待人工输入验证码，不提前选择地区/分行/日期/时间");
            await this.waitForHumanVerificationLoop("客户资料已填写，等待人工验证码");
            await page.waitForLoadState("domcontentloaded").catch(() => undefined);
            await page.waitForTimeout(1000);
            continue;
          }
          if (this.manualCaptchaInputAcknowledged) {
            await this.logger.result("人工验证码已输入，开始补齐地区/分行/日期/时间");
          }
          latestSlot = await this.fillSlotSelectionWithinManualWindow("customer-info-slot-fields");
          if (!latestSlot) {
            const blockedResult = this.slotSelectionBlockedResult();
            if (blockedResult) return blockedResult;
            await this.saveFullDiagnosis("customer-info-no-slot");
            return { status: "no-slot", reason: "当前条件下没有可用时段，已保存页面诊断。" };
          }
          this.latestSlot = latestSlot;
          this.lockedSlotSubmitAttempts = 0;
          await this.logger.result(`已锁定号源：${latestSlot.district ?? ""} ${latestSlot.branch} ${latestSlot.date} ${latestSlot.time}`);
          await this.humanVerificationHooks.onStatus?.("slot-locked", `已锁定号源：${latestSlot.district ?? ""} ${latestSlot.branch} ${latestSlot.date} ${latestSlot.time}`);
          const lockedSubmitResult = await this.submitLockedSlotAndWait("客户资料页补齐并锁定号源");
          if (lockedSubmitResult) return lockedSubmitResult;
          continue;
        }
        if (await this.hasHumanVerification()) {
          this.lastStep = "客户资料已填写，等待人工输入验证码";
          await this.logger.result(this.lastStep);
          await this.waitForHumanVerificationLoop("客户资料已填写，等待人工验证码");
          await page.waitForLoadState("domcontentloaded").catch(() => undefined);
          await page.waitForTimeout(1000);
          continue;
        }
        await this.clickContinueByText();
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await page.waitForTimeout(1200);
        continue;
      }

      if (pageType === "CONFIRMATION") {
        this.lastStep = "确认页：检查并提交";
        await this.logger.step("确认页：检查并提交", page);
        const submitResult = await this.submitConfirmationAndClassify(latestSlot ?? this.latestSlot, submitRetries);
        if (submitResult.status === "booked" || submitResult.status === "needs-human") {
          return submitResult;
        }
        if (this.options.singleScan && submitResult.status === "no-slot") {
          if (!this.shouldContinueManualScan()) {
            await this.logger.result("人工启动扫描窗口结束：提交后未成功锁定号源，结束本次检查。");
            return submitResult;
          }
          await this.tryReturnToSlotSelection();
          await page.waitForTimeout(this.manualScanIntervalMs());
          continue;
        }
        if (submitResult.status === "no-slot" && /已满|已滿|slot/i.test(submitResult.reason)) {
          submitRetries = 0;
          await this.tryReturnToSlotSelection();
          continue;
        }
        if (submitResult.status === "no-slot") {
          continue;
        }
        submitRetries += 1;
        if (submitRetries > 2) {
          await this.saveFullDiagnosis("confirmation-timeout");
          return { status: "needs-human", reason: "最终提交后 15 秒内没有明确结果，重试 2 次后仍无法判断，已保留现场。" };
        }
        continue;
      }

      if (pageType === "SUCCESS") {
        this.lastStep = "成功页：提取预约结果";
        await this.logger.step("成功页：提取预约结果", page);
        const result = await this.extractResultAndFinish(latestSlot);
        if (result) {
          return result;
        }
        await this.saveFullDiagnosis("success-without-reference");
        return { status: "needs-human", reason: "页面像是成功页，但没有提取到预约编号，已保留现场。" };
      }

      await this.saveFullDiagnosis(`unknown-${iteration}`);
      await this.humanVerificationHooks.onWaiting?.("需人工检查");
      console.log("无法识别当前预约页面，请在浏览器检查页面后按 Enter 继续");
      const readline = createInterface({ input, output });
      await readline.question("");
      readline.close();
    }

    await this.saveFullDiagnosis("state-machine-loop-limit");
    return { status: "needs-human", reason: "状态机循环次数过多，已保留浏览器现场和调试文件。" };
  }

  private async detectCurrentPageType(): Promise<AppointmentPageType> {
    const page = this.requirePage();
    const scopes = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
    const detectedTypes: AppointmentPageType[] = [];
    for (const scope of scopes) {
      const type = await detectAppointmentPageType(scope);
      detectedTypes.push(type);
    }
    const priority: AppointmentPageType[] = ["SUCCESS", "CONFIRMATION", "CUSTOMER_INFO", "SLOT_SELECTION", "CAPTCHA"];
    for (const type of priority) {
      if (detectedTypes.includes(type)) return type;
    }
    return "UNKNOWN";
  }

  private async fillSlotSelection(): Promise<Slot | undefined> {
    this.slotSelectionBlockedReason = undefined;
    this.stopManualScanAfterCurrentAttempt = false;
    this.slotSelectionModeOverride = "date-first";
    const modeReady = await this.selectSlotSelectionMode();
    if (!modeReady) {
      this.slotSelectionBlockedReason = `未能切换到${this.slotSelectionModeLabels()[0]}，已停止本轮号源判断。`;
      await this.saveSlotAnalysis({
        reachedSecondPage: true,
        availableDates: [],
        availableSlots: {},
        requestedDate: (this.request.appointment.preferredDates ?? []).join(", "),
        requestedSlots: this.request.appointment.preferredTimes ?? [],
        matchedSlot: null,
        noMatchReason: this.slotSelectionBlockedReason
      });
      return undefined;
    }
    await this.logger.result("单行道选号流程启动：锁定日期 -> 锁定时间 -> 锁定区域 -> 锁定分行 -> 提交；中途不回退重选。");
    const dateLocator = await this.findSlotSelect("date");
    const timeLocator = await this.findSlotSelect("time");
    const slotAnalysis = this.createSlotAnalysisBase();

    const dateSelected = this.lockedDateForScan
      ?? await this.selectFirstMatchingDate(bochkSelectors.date, dateLocator);
    if (!dateSelected) {
      this.noAvailableDateAttempts += 1;
      await this.saveSlotAnalysis({
        ...slotAnalysis,
        noMatchReason: `没有符合条件的可预约日期（第 ${this.noAvailableDateAttempts} 次）。`
      });
      await this.logger.result(`没有符合条件的可预约日期：第 ${this.noAvailableDateAttempts} 次`);
      return undefined;
    }
    this.noAvailableDateAttempts = 0;
    this.lockedDateForScan = dateSelected;
    slotAnalysis.availableDates = [dateSelected];
    await this.logger.result(`单行道已锁定日期：${dateSelected}${this.lockedDateForScan === dateSelected ? "（后续扫描复用，不再重开日期）" : ""}`);

    await this.requirePage().waitForTimeout(400);
    if (!await this.verifyLockedAppointmentDate(dateSelected)) {
      this.slotSelectionBlockedReason = `日期 ${dateSelected} 已锁定，但页面上的日期输入值已丢失或不匹配；停止自动扫描，避免回退重选。`;
      await this.saveSlotAnalysis({
        ...slotAnalysis,
        noMatchReason: this.slotSelectionBlockedReason
      });
      await this.logger.result(this.slotSelectionBlockedReason);
      return undefined;
    }
    const freshTimeLocator = await this.findSlotSelect("time") ?? timeLocator;
    const availableSlotsForDate = await this.readAvailableOptionsFromLocator(freshTimeLocator);
    slotAnalysis.availableSlots[dateSelected] = availableSlotsForDate;
    const matchingTimes = await this.matchingTimeOptionsFromLocator(freshTimeLocator);
    if (matchingTimes.length === 0) {
      this.stopManualScanAfterCurrentAttempt = true;
      await this.saveSlotAnalysis({
        ...slotAnalysis,
        noMatchReason: "没有符合条件的可预约时间。"
      });
      return undefined;
    }

    const failedTimeReasons: string[] = [];
    for (const timeOption of matchingTimes) {
      const timeSelected = await this.selectTimeOptionFromLocator(freshTimeLocator, timeOption);
      if (!timeSelected) {
        failedTimeReasons.push(`${timeOption.label || timeOption.value}: 时间选择失败`);
        await this.logger.result(`日期 ${dateSelected} 已锁定，时间 ${timeOption.label || timeOption.value} 选择失败，继续扫描下一个时间段。`);
        continue;
      }
      await this.logger.result(`单行道已锁定候选时间：${timeSelected}`);

      const districtCandidate = await this.waitForPreferredOrAvailableSlotOptions(
        "district",
        this.request.appointment.preferredDistricts,
        "区域",
        { skipFull: true }
      );
      const districtLocator = districtCandidate.locator;
      const districtOptions = districtCandidate.options;
      if (districtOptions.length === 0) {
        failedTimeReasons.push(`${timeSelected}: 没有可用区域`);
        await this.logger.result(`日期 ${dateSelected} 已锁定，时间 ${timeSelected} 没有可用区域，继续扫描下一个时间段。`);
        continue;
      }

      const failedDistrictReasons: string[] = [];
      for (const districtOption of districtOptions) {
        const selectedDistrict = await this.selectOptionSnapshot(districtLocator, districtOption, "区域");
        if (!selectedDistrict) {
          failedDistrictReasons.push(`${districtOption.label || districtOption.value}: 区域选择失败`);
          continue;
        }
        await this.logger.result(`单行道已锁定区域：${selectedDistrict}`);

        const branchCandidate = await this.waitForPreferredOrAvailableSlotOptions(
          "branch",
          this.request.appointment.preferredBranches,
          "分行",
          { skipFull: true }
        );
        const branchLocator = branchCandidate.locator;
        const branchOptions = branchCandidate.options;
        if (branchOptions.length === 0) {
          failedDistrictReasons.push(`${selectedDistrict}: 没有可用分行`);
          await this.logger.result(`日期 ${dateSelected}、时间 ${timeSelected}、区域 ${selectedDistrict} 没有可用分行，继续扫描同一时间点的下一个区域。`);
          continue;
        }

        for (const branchOption of branchOptions) {
          const selectedBranch = await this.selectOptionSnapshot(branchLocator, branchOption, "分行");
          if (!selectedBranch) {
            failedDistrictReasons.push(`${selectedDistrict}/${branchOption.label || branchOption.value}: 分行选择失败`);
            continue;
          }
          await this.logger.result(`单行道已锁定分行：${selectedBranch}`);

          const matchedSlot = {
            branch: await this.selectedLabelFromLocator(branchLocator) ?? selectedBranch,
            district: await this.selectedLabelFromLocator(districtLocator) ?? selectedDistrict,
            date: await this.selectedLabelFromLocator(dateLocator) ?? dateSelected,
            time: await this.selectedLabelFromLocator(freshTimeLocator) ?? timeSelected
          };
          await this.saveSlotAnalysis({
            ...slotAnalysis,
            matchedSlot,
            noMatchReason: ""
          });
          await this.logger.result(`单行道号源已完整锁定：${matchedSlot.date} ${matchedSlot.time} ${matchedSlot.district ?? ""} ${matchedSlot.branch}`);
          return matchedSlot;
        }
      }

      failedTimeReasons.push(`${timeSelected}: 已扫描所有合适区域但没有可用分行（${failedDistrictReasons.join("；") || "无可用分行"}）`);
      await this.logger.result(`日期 ${dateSelected} 已锁定，时间 ${timeSelected} 已扫描所有合适区域但没有可用分行，继续扫描下一个时间段。`);
    }

    this.stopManualScanAfterCurrentAttempt = true;
    await this.saveSlotAnalysis({
      ...slotAnalysis,
      noMatchReason: failedTimeReasons.length > 0
        ? `日期 ${dateSelected} 已锁定，但所有匹配时间段都没有可用区域/分行：${failedTimeReasons.join("；")}`
        : `日期 ${dateSelected} 已锁定，但没有可用区域/分行。`
    });
    await this.logger.result(`日期 ${dateSelected} 已锁定，但本轮所有匹配时间段都没有可用区域/分行，停止本轮扫描。`);
    return undefined;
  }

  private async verifyLockedAppointmentDate(expectedDate: string): Promise<boolean> {
    const actualDate = await this.currentSelectedAppointmentDate();
    if (!actualDate) {
      await this.logger.result(`日期锁定校验失败：页面日期输入框为空或不可读，期望=${expectedDate}`);
      return false;
    }
    const matched = dateOptionMatches(actualDate, actualDate, expectedDate);
    await this.logger.result(`${matched ? "日期锁定校验通过" : "日期锁定校验失败"}：页面=${actualDate}，期望=${expectedDate}`);
    return matched;
  }

  private async fillSlotSelectionBranchFirst(): Promise<Slot | undefined> {
    const slotAnalysis = this.createSlotAnalysisBase();
    const failedReasons: string[] = [];
    const districtLocator = await this.findSlotSelect("district");
    const districtOptions = await this.preferredOrAvailableOptionsFromLocator(
      districtLocator,
      this.request.appointment.preferredDistricts,
      "区域",
      { skipFull: true }
    );

    if (districtOptions.length === 0) {
      await this.saveSlotAnalysis({
        ...slotAnalysis,
        noMatchReason: "分行优先模式：没有符合条件的区域。"
      });
      return undefined;
    }

    for (const districtOption of districtOptions) {
      const selectedDistrict = await this.selectOptionSnapshot(districtLocator, districtOption, "区域");
      if (!selectedDistrict) {
        failedReasons.push(`区域 ${districtOption.label || districtOption.value} 选择失败`);
        continue;
      }

      await this.requirePage().waitForTimeout(500);
      const branchLocator = await this.findSlotSelect("branch");
      const branchOptions = await this.preferredOrAvailableOptionsFromLocator(
        branchLocator,
        this.request.appointment.preferredBranches,
        "分行",
        { skipFull: true }
      );

      if (branchOptions.length === 0) {
        failedReasons.push(`${selectedDistrict}: 没有可用分行`);
        continue;
      }

      for (const branchOption of branchOptions) {
        const selectedBranch = await this.selectOptionSnapshot(branchLocator, branchOption, "分行");
        if (!selectedBranch) {
          failedReasons.push(`${selectedDistrict}: 分行 ${branchOption.label || branchOption.value} 选择失败`);
          continue;
        }

        await this.requirePage().waitForTimeout(500);
        const dateLocator = await this.findSlotSelect("date");
        const dateSelected = await this.selectFirstMatchingDate(bochkSelectors.date, dateLocator);
        if (!dateSelected) {
          failedReasons.push(`${selectedDistrict}/${selectedBranch}: 没有符合条件的可预约日期`);
          continue;
        }

        this.noAvailableDateAttempts = 0;
        slotAnalysis.availableDates = Array.from(new Set([...slotAnalysis.availableDates, dateSelected]));

        await this.requirePage().waitForTimeout(400);
        const timeLocator = await this.findSlotSelect("time");
        const availableSlotsForDate = await this.readAvailableOptionsFromLocator(timeLocator);
        slotAnalysis.availableSlots[dateSelected] = Array.from(new Set([
          ...(slotAnalysis.availableSlots[dateSelected] ?? []),
          ...availableSlotsForDate
        ]));
        const matchingTimes = await this.matchingTimeOptionsFromLocator(timeLocator);
        if (matchingTimes.length === 0) {
          failedReasons.push(`${selectedDistrict}/${selectedBranch}/${dateSelected}: 没有符合条件的可预约时间`);
          continue;
        }

        for (const timeOption of matchingTimes) {
          const timeSelected = await this.selectTimeOptionFromLocator(timeLocator, timeOption);
          if (!timeSelected) {
            failedReasons.push(`${selectedDistrict}/${selectedBranch}/${dateSelected}: 时间 ${timeOption.label || timeOption.value} 选择失败`);
            continue;
          }

          const matchedSlot = {
            branch: await this.selectedLabelFromLocator(branchLocator) ?? selectedBranch,
            district: await this.selectedLabelFromLocator(districtLocator) ?? selectedDistrict,
            date: await this.selectedLabelFromLocator(dateLocator) ?? dateSelected,
            time: await this.selectedLabelFromLocator(timeLocator) ?? timeSelected
          };
          await this.saveSlotAnalysis({
            ...slotAnalysis,
            matchedSlot,
            noMatchReason: ""
          });
          return matchedSlot;
        }
      }
    }

    if (slotAnalysis.availableDates.length === 0) {
      this.noAvailableDateAttempts += 1;
    }
    await this.saveSlotAnalysis({
      ...slotAnalysis,
      noMatchReason: failedReasons.length > 0
        ? `分行优先模式未找到可提交组合：${failedReasons.join("；")}`
        : "分行优先模式没有找到可提交组合。"
    });
    return undefined;
  }

  private async fillSlotSelectionWithinManualWindow(label: string): Promise<Slot | undefined> {
    const windowMs = this.options.manualScanWindowMs ?? 0;
    if (!this.options.singleScan || windowMs <= 0) {
      return this.fillSlotSelection();
    }

    this.startManualScanWindow();
    this.slotSelectionModeOverride = "date-first";
    let attempts = 0;
    let fullLineModeSwitches = 0;
    let endedBySingleEffectiveScan = false;
    let endedByNoDateLimit = false;
    const maxNoAvailableDateAttempts = 3;
    const maxFullLineModeSwitches = 5;
    while (
      attempts === 0
      || Date.now() <= this.manualScanDeadlineAt
      || fullLineModeSwitches > 0 && fullLineModeSwitches < maxFullLineModeSwitches
    ) {
      attempts += 1;
      await this.logger.result(`人工启动扫描 ${label} 第 ${attempts} 次`);
      const slot = await this.fillSlotSelection();
      if (slot) return slot;
      const shouldAlternateSelectionMode = await this.hasAllBranchesSevenDaysFullMessage()
        || fullLineModeSwitches > 0 && this.noAvailableDateAttempts > 0;
      if (shouldAlternateSelectionMode) {
        fullLineModeSwitches += 1;
        if (fullLineModeSwitches >= maxFullLineModeSwitches) {
          if (this.canExitManualScanWindow()) {
            await this.logger.result(`检测到全线分行 7 日内已满，已切换预约条件模式 ${fullLineModeSwitches} 次，停止本次扫描。`);
            endedByNoDateLimit = true;
            break;
          }
          await this.logger.result(`检测到全线分行 7 日内已满，已切换预约条件模式 ${fullLineModeSwitches} 次；未到 xx:32，继续扫描。`);
          fullLineModeSwitches = 0;
          await this.requirePage().waitForTimeout(this.manualScanIntervalMs());
          continue;
        }
        await this.toggleSlotSelectionModeOverride();
        await this.logger.result(`检测到全线分行 7 日内已满，切换预约条件模式后重试：第 ${fullLineModeSwitches + 1}/${maxFullLineModeSwitches} 次`);
        await this.requirePage().waitForTimeout(500);
        continue;
      }
      if (this.noAvailableDateAttempts >= maxNoAvailableDateAttempts) {
        if (this.canExitManualScanWindow()) {
          await this.logger.result(`连续 ${this.noAvailableDateAttempts} 次找不到可预约日期，停止本次扫描。`);
          endedByNoDateLimit = true;
          break;
        }
        await this.logger.result(`连续 ${this.noAvailableDateAttempts} 次找不到可预约日期；未到 xx:32，继续扫描。`);
      }
      if (this.slotSelectionBlockedReason) break;
      if (this.stopManualScanAfterCurrentAttempt) {
        await this.logger.result("人工启动扫描已完成一次有效日期/时间检查，继续等待下次扫描。");
        endedBySingleEffectiveScan = true;
      }
      if (!this.shouldContinueManualScan()) {
        break;
      }
      await this.requirePage().waitForTimeout(this.manualScanIntervalMs());
    }

    if (endedByNoDateLimit) {
      await this.logger.result(`人工启动扫描 ${label} 已停止：连续 ${maxNoAvailableDateAttempts} 次没有可预约日期。`);
    } else if (endedBySingleEffectiveScan) {
      await this.logger.result(`人工启动扫描 ${label} 已完成扫描窗口：本轮曾完成日期/时间检查但没有符合条件的后续选项。`);
    } else {
      await this.logger.result(`人工启动扫描 ${label} 已到达 xx:32 或 ${Math.round(windowMs / 1000)} 秒窗口，结束本次检查。`);
    }
    return undefined;
  }

  private startManualScanWindow(): void {
    if (this.manualScanDeadlineAt > Date.now()) return;
    const windowDeadline = Date.now() + (this.options.manualScanWindowMs ?? 0);
    this.manualScanDeadlineAt = Math.min(windowDeadline, currentHalfHourMinute32Cutoff(new Date()).getTime());
  }

  private canExitManualScanWindow(): boolean {
    this.startManualScanWindow();
    return Date.now() >= this.manualScanDeadlineAt;
  }

  private shouldContinueManualScan(): boolean {
    const windowMs = this.options.manualScanWindowMs ?? 0;
    if (!this.options.singleScan || windowMs <= 0) return false;
    this.startManualScanWindow();
    return Date.now() < this.manualScanDeadlineAt;
  }

  private manualScanIntervalMs(): number {
    const configured = this.request.runner.releaseWindowRefreshIntervalMs || 1500;
    return Math.max(1000, configured);
  }

  private currentSlotSelectionMode(): "date-first" | "branch-first" {
    return this.slotSelectionModeOverride ?? this.request.appointment.selectionMode ?? "date-first";
  }

  private async toggleSlotSelectionModeOverride(): Promise<void> {
    this.slotSelectionModeOverride = this.currentSlotSelectionMode() === "date-first" ? "branch-first" : "date-first";
    await this.logger.result(`预约条件模式切换为：${this.slotSelectionModeOverride === "date-first" ? "先選定預約日期和時間" : "先選定分行"}`);
  }

  private async hasAllBranchesSevenDaysFullMessage(): Promise<boolean> {
    const text = await this.visibleText();
    return /全[線线]分行\s*7\s*日[內内]的?[預预]約開戶日期已[滿满]|全[線线]分行.*7\s*日.*開戶日期已[滿满]/i.test(text);
  }

  private async prefillSlotFilters(): Promise<void> {
    const mode = this.request.appointment.selectionMode ?? "date-first";
    if (!await this.selectSlotSelectionMode()) {
      this.slotSelectionBlockedReason = `未能切换到${this.slotSelectionModeLabels()[0]}，跳过本次第二页预填。`;
      await this.logger.result(this.slotSelectionBlockedReason);
      return;
    }
    if (mode === "branch-first") {
      await this.selectFirstMatchingOption(
        bochkSelectors.district,
        this.request.appointment.preferredDistricts,
        { skipFull: true }
      );
      await this.selectFirstMatchingOption(bochkSelectors.branch, this.request.appointment.preferredBranches, { skipFull: true });
      await this.selectFirstMatchingDate(bochkSelectors.date);
      await this.logger.result("已按分行优先预填区域/分行/日期条件，未点击最终提交。");
      return;
    }

    await this.selectFirstMatchingDate(bochkSelectors.date);
    const timeLocator = await this.findSlotSelect("time");
    await this.selectFirstMatchingTime(bochkSelectors.time, timeLocator);
    await this.logger.result("已按日期时间优先预填预约日期/时间条件，未点击最终提交。");
  }

  private createSlotAnalysisBase(): SlotAnalysis {
    return {
      reachedSecondPage: true,
      availableDates: [],
      availableSlots: {},
      requestedDate: (this.request.appointment.preferredDates ?? []).join(", "),
      requestedSlots: this.request.appointment.preferredTimes ?? [],
      matchedSlot: null,
      noMatchReason: ""
    };
  }

  private async collectSlotAnalysis(
    dateSelector: string,
    timeSelector: string,
    knownDateLocator?: Locator,
    knownTimeLocator?: Locator
  ): Promise<SlotAnalysis> {
    const safeKnownDateLocator = knownDateLocator && await this.isDateSelectLocator(knownDateLocator)
      ? knownDateLocator
      : undefined;
    const calendarOpened = safeKnownDateLocator ? false : await this.isCalendarPopupOpen();
    const requestedDate = (this.request.appointment.preferredDates ?? []).join(", ");
    const requestedSlots = this.request.appointment.preferredTimes ?? [];
    const analysis: SlotAnalysis = {
      reachedSecondPage: true,
      availableDates: [],
      availableSlots: {},
      requestedDate,
      requestedSlots,
      matchedSlot: null,
      noMatchReason: ""
    };

    const dateLocator = safeKnownDateLocator ?? await this.firstVisibleDateSelect(dateSelector, requestedDate);
    if (!dateLocator) {
      if (!calendarOpened) {
        this.slotSelectionBlockedReason = "未能打开预约日期日历，已停止本轮号源判断。";
        analysis.noMatchReason = this.slotSelectionBlockedReason;
        await this.saveSlotAnalysis(analysis);
        return analysis;
      }
      analysis.availableDates = await this.readCalendarDateOptions();
      analysis.noMatchReason = analysis.availableDates.length === 0
        ? "No available dates found."
        : "Dates found, but no available time slots.";
      await this.saveSlotAnalysis(analysis);
      return analysis;
    }

    const originalDateValue = await dateLocator.evaluate((node) => (node as HTMLSelectElement).value).catch(() => "");
    const dateOptions = await this.readSelectOptions(dateLocator);
    const availableDateOptions = dateOptions.filter((option) => this.isAvailableDateOption(option));
    analysis.availableDates = availableDateOptions.map((option) => option.label || option.value);

    for (const dateOption of availableDateOptions) {
      if (!dateOption.value) continue;
      await this.markAutomationAction();
      await dateLocator.selectOption(dateOption.value).catch(() => undefined);
      await this.requirePage().waitForTimeout(400);
      const timeLocator = knownTimeLocator ?? await this.firstVisibleLocator(timeSelector) ?? await this.findSelectByText(requestedSlots.join(" "));
      const timeOptions = timeLocator ? await this.readSelectOptions(timeLocator) : [];
      analysis.availableSlots[dateOption.label || dateOption.value] = timeOptions
        .filter((option) => this.isAvailableTimeOption(option))
        .map((option) => option.label || option.value);
    }

    if (analysis.availableDates.length > 0) {
      await this.logger.result(`诊断扫描发现可选日期后保持当前日期，不恢复原值：original=${originalDateValue || "空"}`);
    }

    analysis.noMatchReason = this.slotNoMatchReason(analysis);
    await this.saveSlotAnalysis(analysis);
    return analysis;
  }

  private async readSelectOptions(locator: Locator): Promise<SelectOptionSnapshot[]> {
    return locator.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: node.textContent?.trim() ?? "",
        value: (node as HTMLOptionElement).value,
        disabled: (node as HTMLOptionElement).disabled
      }))
    ).catch(() => []);
  }

  private isAvailableDateOption(option: SelectOptionSnapshot): boolean {
    return Boolean(option.value)
      && !option.disabled
      && !/請選|请选择|select|已滿|已满|full/i.test(option.label);
  }

  private isAvailableTimeOption(option: SelectOptionSnapshot): boolean {
    return Boolean(option.value)
      && !option.disabled
      && !/請選|请选择|select|已滿|已满|full/i.test(option.label);
  }

  private isAvailableGenericOption(option: SelectOptionSnapshot, matchOptions: { skipFull?: boolean } = {}): boolean {
    return Boolean(option.value)
      && !option.disabled
      && !/請選|请选择|select/i.test(option.label)
      && (!matchOptions.skipFull || !/已滿|已满|full/i.test(option.label));
  }

  private async matchingOptionsFromLocator(
    locator: Locator | undefined,
    preferredLabels: string[],
    fieldName: string,
    matchOptions: { skipFull?: boolean } = {}
  ): Promise<SelectOptionSnapshot[]> {
    if (!locator) {
      await this.logger.result(`选择失败：找不到 ${fieldName} 下拉框`);
      return [];
    }

    const options = await this.readSelectOptions(locator);
    const available = options.filter((option) => this.isAvailableGenericOption(option, matchOptions));
    const matching = preferredLabels.length > 0
      ? available.filter((option) => preferredLabels.some((label) => optionLabelMatches(option, label)))
      : available;

    await this.logger.result(
      `${fieldName} 可尝试选项：${matching.map((option) => option.label || option.value).join(", ") || "无"}`
    );
    return matching;
  }

  private async preferredOrAvailableOptionsFromLocator(
    locator: Locator | undefined,
    preferredLabels: string[],
    fieldName: string,
    matchOptions: { skipFull?: boolean } = {}
  ): Promise<SelectOptionSnapshot[]> {
    if (!locator) {
      await this.logger.result(`选择失败：找不到 ${fieldName} 下拉框`);
      return [];
    }

    const options = await this.readSelectOptions(locator);
    const available = options.filter((option) => this.isAvailableGenericOption(option, matchOptions));
    if (preferredLabels.length === 0) {
      await this.logger.result(
        `${fieldName} 可尝试选项：${available.map((option) => option.label || option.value).join(", ") || "无"}`
      );
      return available;
    }

    const matching = available.filter((option) => preferredLabels.some((label) => optionLabelMatches(option, label)));
    if (matching.length > 0) {
      await this.logger.result(
        `${fieldName} 偏好可尝试选项：${matching.map((option) => option.label || option.value).join(", ")}`
      );
      return matching;
    }

    await this.logger.result(
      `${fieldName} 偏好选项当前不可用，已按用户选择保持严格匹配，不降级到其他选项；网页可用选项：${available.map((option) => option.label || option.value).join(", ") || "无"}`
    );
    return [];
  }

  private async waitForPreferredOrAvailableSlotOptions(
    kind: "district" | "branch",
    preferredLabels: string[],
    fieldName: string,
    matchOptions: { skipFull?: boolean } = {},
    maxAttempts = 6
  ): Promise<{ locator?: Locator; options: SelectOptionSnapshot[] }> {
    let latestLocator: Locator | undefined;
    let latestOptions: SelectOptionSnapshot[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      latestLocator = await this.findSlotSelect(kind);
      latestOptions = await this.preferredOrAvailableOptionsFromLocator(
        latestLocator,
        preferredLabels,
        fieldName,
        matchOptions
      );
      if (latestOptions.length > 0) {
        if (attempt > 1) {
          await this.logger.result(`${fieldName} 选项第 ${attempt} 次刷新后出现：${latestOptions.map((option) => option.label || option.value).join(", ")}`);
        }
        return { locator: latestLocator, options: latestOptions };
      }

      if (attempt < maxAttempts) {
        await this.logger.result(`${fieldName} 暂无可选项，等待网页刷新下拉选项：第 ${attempt}/${maxAttempts} 次`);
        await this.requirePage().waitForTimeout(500);
      }
    }

    return { locator: latestLocator, options: latestOptions };
  }

  private async selectOptionSnapshot(
    locator: Locator | undefined,
    option: SelectOptionSnapshot,
    fieldName: string
  ): Promise<string | undefined> {
    if (!locator || !option.value) return undefined;
    await this.markAutomationAction();
    await locator.selectOption(option.value).catch(() => undefined);
    await this.requirePage().waitForTimeout(250);
    const selectedValue = await locator.evaluate((node) => (node as HTMLSelectElement).value).catch(() => "");
    if (selectedValue !== option.value) {
      await this.logger.result(`选择失败：${fieldName} -> ${option.label || option.value}`);
      return undefined;
    }
    const label = option.label || option.value;
    await this.logger.result(`选择成功：${fieldName} -> ${label}`);
    return label;
  }

  private slotNoMatchReason(analysis: SlotAnalysis): string {
    if (analysis.availableDates.length === 0) {
      return "没有可预约日期。";
    }
    const allSlots = Object.values(analysis.availableSlots).flat();
    if (allSlots.length === 0) {
      return "已发现可预约日期，但没有可预约时间。";
    }
    return "有可预约时间，但不匹配任务要求。";
  }

  private async saveSlotAnalysis(analysis: SlotAnalysis): Promise<void> {
    const path = resolve("debug", "slot-analysis.json");
    await mkdir(resolve("debug"), { recursive: true });
    await writeFile(path, `${JSON.stringify(analysis, null, 2)}\n`);
    await this.logger.result(`第二页号源诊断已保存：${path}`);
  }

  private async submitLockedSlotAndWait(reason: string): Promise<BookingResult | undefined> {
    const page = this.requirePage();
    if (this.lockedSlotSubmitAttempts >= 2) {
      await this.logger.result(`${reason}：已锁定号源并提交 ${this.lockedSlotSubmitAttempts} 次，但页面仍未进入确认/成功页；停止回退重选，保留现场人工检查。`);
      await this.saveFullDiagnosis("locked-slot-submit-stalled");
      return {
        status: "needs-human",
        reason: "已锁定日期/时间/区域/分行，但提交后页面没有进入确认或成功页。已停止自动回退重选并保留浏览器现场，请人工检查页面提示。",
      };
    }
    if (this.latestSlot) {
      await this.logger.result(`${reason}：锁定日期=${this.latestSlot.date}，时间=${this.latestSlot.time}，区域=${this.latestSlot.district ?? "未识别"}，分行=${this.latestSlot.branch}；不再返回重选，直接提交。`);
    } else {
      await this.logger.result(`${reason}：未记录 latestSlot，但当前流程要求直接提交。`);
    }
    this.lockedSlotSubmitAttempts += 1;
    const clicked = await this.clickContinueByText();
    await this.logger.result(clicked ? "锁定号源后已点击提交/继续。" : "锁定号源后未找到提交/继续按钮，保留现场。");
    this.manualCaptchaInputAcknowledged = false;
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(1200);
    return undefined;
  }

  private async finishFromCurrentPage(): Promise<BookingResult> {
    const page = this.requirePage();
    for (let iteration = 1; iteration <= 12; iteration += 1) {
      const pageType = await this.detectCurrentPageType();
      await this.logger.step(`FINAL_SUBMIT 状态机页面类型：${pageType}`, page);

      const terminalResult = await this.finishTerminalPageIfPresent(this.latestSlot);
      if (terminalResult) {
        return terminalResult;
      }

      if (pageType === "CAPTCHA") {
        await this.waitForManualCaptcha();
        continue;
      }

      if (pageType === "CUSTOMER_INFO") {
        if (this.latestSlot && await this.hasSlotSelectionFields()) {
          const lockedSubmitResult = await this.submitLockedSlotAndWait("最终提交阶段已有锁定号源");
          if (lockedSubmitResult) return lockedSubmitResult;
          continue;
        }
        const humanBlock = await this.fillCustomerInfo();
        if (humanBlock) return humanBlock;
        if (await this.hasSlotSelectionFields()) {
          if (this.latestSlot) {
            const lockedSubmitResult = await this.submitLockedSlotAndWait("最终提交阶段填写资料后已有锁定号源");
            if (lockedSubmitResult) return lockedSubmitResult;
            continue;
          }
          const slot = await this.fillSlotSelection();
          if (!slot) {
            const blockedResult = this.slotSelectionBlockedResult();
            if (blockedResult) return blockedResult;
            return { status: "no-slot", reason: "当前没有符合条件的可预约时段。" };
          }
          this.latestSlot = slot;
          this.lockedSlotSubmitAttempts = 0;
          await this.clickContinueByText();
          await page.waitForTimeout(1000);
          continue;
        }
        await this.clickContinueByText();
        await page.waitForTimeout(1000);
        continue;
      }

      if (pageType === "CONFIRMATION") {
        return this.submitConfirmationAndClassify(this.latestSlot, 0);
      }

      if (pageType === "SUCCESS") {
        const result = await this.extractResultAndFinish(this.latestSlot);
        if (result) return result;
        await this.saveFullDiagnosis("success-without-reference");
        return { status: "needs-human", reason: "成功页未提取到预约编号，已保留现场。" };
      }

      if (pageType === "SLOT_SELECTION") {
        return { status: "no-slot", reason: "仍在选号源页，继续扫描。" };
      }

      await this.saveFullDiagnosis(`final-submit-unknown-${iteration}`);
      return { status: "needs-human", reason: "最终提交中遇到未知页面，已保存诊断并保留现场。" };
    }

    await this.saveFullDiagnosis("final-submit-loop-limit");
    return { status: "needs-human", reason: "最终提交状态机循环次数过多，已保留现场。" };
  }

  private async fillCustomerInfo(): Promise<BookingResult | undefined> {
    const page = this.requirePage();
    const { customer } = this.request;
    await this.selectSalutationRadio(customer.salutation);
    await this.fillIfVisible(bochkSelectors.surname, customer.surname);
    await this.fillIfVisible(bochkSelectors.givenName, customer.givenName);
    await this.selectCountryCodeRadio(customer.countryCode || "86")
      || await this.selectFirstMatchingOption(bochkSelectors.countryCode, [customer.countryCode, "86 中國內地", "86 中国内地"])
      || await this.selectOptionByContext(/國家|国家|區域|区域|country|area|電話區號|电话区号|country code/i, /86|中國內地|中国内地|China/i, "國家/區域編號")
      || await this.selectOptionByVisibleOption(/(^|\D)86(\D|$)|中國內地|中国内地|China/i, "國家/區域編號");
    await this.fillIfVisible(bochkSelectors.phone, customer.phone);
    await this.fillIfVisible(bochkSelectors.email, customer.email);
    await this.fillLikelyDocumentNumber();
    await this.fillOtherRequiredFields();
    if (!await this.selectSlotSelectionMode()) {
      this.slotSelectionBlockedReason = `未能切换到${this.slotSelectionModeLabels()[0]}，已停止本轮号源判断。`;
      await this.logger.result(this.slotSelectionBlockedReason);
      return this.slotSelectionBlockedResult();
    }

    return undefined;
  }

  private slotSelectionModeLabels(): string[] {
    return this.currentSlotSelectionMode() === "branch-first"
      ? ["先選定分行", "先选定分行"]
      : ["先選定預約日期和時間", "先选定预约日期和时间", "先選定預約日期", "先选定预约日期"];
  }

  private async selectSlotSelectionMode(): Promise<boolean> {
    const labels = this.slotSelectionModeLabels();
    const directSelection = await this.selectSlotSelectionModeByKnownValue();
    if (directSelection && await this.isExpectedSlotSelectionMode(labels)) {
      await this.logger.result(`选择预约条件模式：${directSelection.label} value=${directSelection.value} direct`);
      return true;
    }

    const textNodeSelection = await this.selectRadioByTextNode(labels);
    if (textNodeSelection && await this.isExpectedSlotSelectionMode(labels)) {
      await this.logger.result(`选择预约条件模式：${textNodeSelection.label} value=${textNodeSelection.value || "无"} textNode=${textNodeSelection.text}`);
      return true;
    }

    const geometricSelection = await this.selectRadioByTextGeometry(labels);
    if (geometricSelection && await this.isExpectedSlotSelectionMode(labels)) {
      await this.logger.result(`选择预约条件模式：${geometricSelection.label} value=${geometricSelection.value || "无"} geometry=${geometricSelection.text}`);
      return true;
    }

    const textSelection = await this.selectRadioByVisibleText(labels);
    if (textSelection && await this.isExpectedSlotSelectionMode(labels)) {
      await this.logger.result(`选择预约条件模式：${textSelection.label} value=${textSelection.value || "无"} text=${textSelection.text}`);
      return true;
    }

    const contextualSelection = await this.selectRadioByPageContext(labels);
    if (contextualSelection && await this.isExpectedSlotSelectionMode(labels)) {
      await this.logger.result(`选择预约条件模式：${contextualSelection.label} value=${contextualSelection.value || "无"} context=${contextualSelection.context}`);
      return true;
    }

    const target = await this.findRadioByNearbyText(labels);
    if (target) {
      await this.markAutomationAction();
      await target.check({ force: true }).catch(async () => {
        await target.evaluate((node) => {
          (window as typeof window & { __bochkAutomationIgnoreUntil?: number }).__bochkAutomationIgnoreUntil = Date.now() + 1500;
          const input = node as HTMLInputElement;
          input.checked = true;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.click();
        }).catch(() => undefined);
      });
      const checked = await target.isChecked().catch(() => false);
      await this.logger.result(`${checked ? "选择" : "尝试选择"}预约条件模式：${labels[0]}`);
      return checked && await this.isExpectedSlotSelectionMode(labels);
    }

    for (const label of labels) {
      if (await this.selectRadioByLabel("input[type='radio']", label)) {
        const verified = await this.isExpectedSlotSelectionMode(labels);
        await this.logger.result(`${verified ? "选择" : "尝试选择"}预约条件模式：${label}`);
        return verified;
      }
    }
    const currentMode = await this.currentSlotSelectionModeText();
    const radioSnapshot = await this.slotSelectionRadioSnapshot();
    await this.logger.result(`选择预约条件模式失败：${labels.join(" / ")}；当前选中：${currentMode || "未识别"}；radio=${radioSnapshot || "未发现"}`);
    return false;
  }

  private async selectSlotSelectionModeByKnownValue(): Promise<{ label: string; value: string } | undefined> {
    const mode = this.currentSlotSelectionMode();
    const value = mode === "branch-first" ? "B" : "D";
    const label = mode === "branch-first" ? "先選定分行" : "先選定預約日期和時間";
    const selector = [
      `#openMCaccount_precondition_field${value}`,
      `input[type='radio'][name='bean.precondition'][value='${value}']`
    ].join(",");

    for (const scope of this.allScopes()) {
      const radio = scope.locator(selector).first();
      if (await radio.count().catch(() => 0) === 0) continue;
      await this.markAutomationAction();
      await radio.evaluate((node) => {
        (window as typeof window & { __bochkAutomationIgnoreUntil?: number }).__bochkAutomationIgnoreUntil = Date.now() + 1500;
        const input = node as HTMLInputElement;
        input.scrollIntoView({ block: "center", inline: "center" });
        input.click();
        input.checked = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }).catch(async () => {
        await radio.check({ force: true }).catch(() => undefined);
      });

      const checkedValue = await scope.locator("input[type='radio'][name='bean.precondition']:checked").first()
        .evaluate((node) => (node as HTMLInputElement).value)
        .catch(() => "");
      if (checkedValue === value) {
        return { label, value };
      }
      await this.logger.result(`预约条件模式直接选择验证失败：目标 value=${value}，实际 value=${checkedValue || "未选中"}`);
    }

    return undefined;
  }

  private slotSelectionBlockedResult(): BookingResult | undefined {
    if (!this.slotSelectionBlockedReason) return undefined;
    return {
      status: "needs-human",
      reason: this.slotSelectionBlockedReason
    };
  }

  private async hasSlotSelectionFields(): Promise<boolean> {
    return Boolean(await this.firstVisibleLocator(bochkSelectors.date)
      ?? await this.firstVisibleLocator(bochkSelectors.time)
      ?? await this.firstVisibleLocator(bochkSelectors.district)
      ?? await this.firstVisibleLocator(bochkSelectors.branch)
      ?? await this.findSelectByContextPattern(/預約日期|预约日期|預約時間|预约时间|分行區域|分行区域|選擇分行|选择分行/i)
      ?? await this.findCalendarDateLocator());
  }

  private async hasCustomerInfoFields(): Promise<boolean> {
    return await this.hasVisibleLocator(bochkSelectors.surname, 300)
      || await this.hasVisibleLocator(bochkSelectors.givenName, 300)
      || await this.hasVisibleLocator(bochkSelectors.phone, 300)
      || await this.hasVisibleLocator(bochkSelectors.email, 300)
      || await this.hasVisibleLocator(bochkSelectors.salutation, 300);
  }

  private async isInitialAccountNoticePage(): Promise<boolean> {
    if (!await this.hasVisibleLocator(bochkSelectors.documentType, 300)) return false;
    if (await this.hasCustomerInfoFields()) return false;
    const text = await this.visibleText().catch(() => "");
    return /資料政策通知|资料政策通知|開戶服務|开户服务|本人.*細閱|本人.*细阅|同意銀行|同意银行/i.test(text);
  }

  private async findSlotSelect(kind: "district" | "branch" | "date" | "time"): Promise<Locator | undefined> {
    const selectorMap = {
      district: bochkSelectors.district,
      branch: bochkSelectors.branch,
      date: bochkSelectors.date,
      time: bochkSelectors.time
    } satisfies Record<typeof kind, string>;
    const direct = await this.firstVisibleLocator(selectorMap[kind]);
    if (direct) {
      if (kind === "date" && !await this.isDateSelectLocator(direct)) return undefined;
      return direct;
    }

    if (kind === "date") {
      return undefined;
    }

    const patterns = {
      district: /分行區域|分行区域|地區|地区|區域|区域|district/i,
      branch: /選擇分行|选择分行|分行|branch/i,
      time: /預約時間|预约时间|預約時段|预约时段|時間|时间|時段|时段|time/i
    } satisfies Record<Exclude<typeof kind, "date">, RegExp>;
    return this.findSelectByContextPattern(patterns[kind]);
  }

  private async firstVisibleDateSelect(selector: string, requestedDate: string): Promise<Locator | undefined> {
    const direct = await this.firstVisibleLocator(selector);
    if (direct && await this.isDateSelectLocator(direct)) return direct;
    const byText = await this.findSelectByText(requestedDate);
    if (byText && await this.isDateSelectLocator(byText)) return byText;
    return undefined;
  }

  private async isDateSelectLocator(locator: Locator): Promise<boolean> {
    const options = await this.readSelectOptions(locator).catch(() => []);
    if (options.length === 0) return false;
    const values = options.map((option) => `${option.label} ${option.value}`).join(" ");
    const hasDateLike = /\b20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}|(?:^|[^\d])\d{1,2}[-/.月]\d{1,2}日?(?:$|[^\d])/i.test(values);
    const hasTimeLike = /\b([01]\d|2[0-3]):[0-5]\d\b/.test(values);
    return hasDateLike || !hasTimeLike && /日期|date/i.test(values);
  }

  private async readAvailableOptionsFromLocator(locator?: Locator): Promise<string[]> {
    if (!locator) return [];
    const options = await this.readSelectOptions(locator).catch(() => []);
    return options
      .filter((option) =>
        option.value
        && !option.disabled
        && !/請選|请选择|select|已滿|已满|full/i.test(option.label)
      )
      .map((option) => option.label || option.value);
  }

  private async findSelectByContextPattern(contextPattern: RegExp): Promise<Locator | undefined> {
    for (const scope of this.allScopes()) {
      const selects = scope.locator("select:visible");
      const count = await selects.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const select = selects.nth(index);
        const text = await select.evaluate((node) => {
          const element = node as HTMLSelectElement;
          const label = element.id ? document.querySelector(`label[for="${element.id}"]`)?.textContent?.trim() || "" : "";
          const parentText = element.parentElement?.textContent?.trim() || "";
          const previousText = element.previousElementSibling?.textContent?.trim() || "";
          const options = Array.from(element.options).map((option) => `${option.textContent?.trim() || ""} ${option.value}`).join(" ");
          return `${element.name} ${element.id} ${label} ${parentText} ${previousText} ${options}`;
        }).catch(() => "");
        if (contextPattern.test(text)) {
          return select;
        }
      }
    }
    return undefined;
  }

  private async waitForManualCaptcha(): Promise<void> {
    await this.waitForHumanVerificationLoop("验证码/人机验证页");
  }

  private async waitForHumanVerificationLoop(reason: string): Promise<void> {
    const page = this.requirePage();
    while (await this.hasHumanVerification()) {
      this.lastStep = `${reason}，等待人工验证`;
      await this.logger.result(this.lastStep);
      await this.centerHumanVerificationArea();
      await this.humanVerificationHooks.onWaiting?.("等待人工验证码");
      console.log("请只在 BOCHK 页面输入验证码，不要点 BOCHK 提交；完成后回到 Dashboard 点击继续");

      const controller = new AbortController();
      const dashboardResume = this.humanVerificationHooks.waitForResume?.(controller.signal) ?? new Promise<void>(() => undefined);
      const readline = input.isTTY ? createInterface({ input, output }) : undefined;
      const terminalResume = readline
        ? readline.question("", { signal: controller.signal }).then(() => undefined).catch(() => undefined)
        : new Promise<void>(() => undefined);
      await Promise.race([terminalResume, dashboardResume]);
      controller.abort();
      readline?.close();

      this.lastStep = "收到继续信号，重新检查页面";
      await this.logger.result("收到继续信号，重新检查页面是否通过人工验证");
      const pageTypeBeforeSubmit = await this.detectCurrentPageType();
      if (pageTypeBeforeSubmit === "CUSTOMER_INFO" && await this.hasSlotSelectionFields()) {
        await this.logger.result("验证码所在页面仍有地区/分行/日期/时间必填项，先不点击网页提交，继续补齐预约条件");
        this.manualCaptchaInputAcknowledged = true;
        break;
      }
      if (await this.hasHumanVerification()) {
        await this.logger.result("收到继续信号后验证码控件仍存在，尝试点击网页继续/提交以提交人工输入验证码");
        const clicked = await this.clickContinueByText();
        await this.logger.result(clicked ? "已点击网页继续/提交，等待验证结果" : "未找到网页继续/提交按钮，继续等待人工处理");
      }
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(1500);
      const pageType = await this.detectCurrentPageType();
      const stillHasVerification = await this.hasHumanVerification();
      if (pageType !== "CAPTCHA" && !stillHasVerification) {
        await this.logger.result(`收到继续信号后继续处理页面：${pageType}`);
        break;
      }
      await this.logger.result(`人工验证仍未通过或仍停留在验证区域：pageType=${pageType} stillHasVerification=${stillHasVerification}`);
    }

    this.lastStep = "人工输入已完成，继续执行";
    this.manualCaptchaInputAcknowledged = true;
    await this.clearManualOverrideFlag();
    await this.humanVerificationHooks.onContinue?.("继续执行");
    await this.logger.result(this.lastStep);
  }

  private async centerHumanVerificationArea(): Promise<void> {
    const page = this.requirePage();
    await page.bringToFront().catch(() => undefined);
    await page.locator("#iframe").first().evaluate((node) => {
      node.scrollIntoView({ block: "center", inline: "center" });
    }).catch(() => undefined);

    if (await this.centerKnownCaptchaInput()) {
      return;
    }

    if (await this.centerLastHumanVerificationInput()) {
      return;
    }

    const inputSelector = [
      "input[id*='captcha' i]",
      "input[name*='captcha' i]",
      "input[class*='captcha' i]",
      "input[id*='verify' i]",
      "input[name*='verify' i]",
      "input[class*='verify' i]",
      "input[id*='verification' i]",
      "input[name*='verification' i]",
      "input[id*='code' i]",
      "input[name*='code' i]",
      "input[id*='valid' i]",
      "input[name*='valid' i]",
      "input[placeholder*='验证码' i]",
      "input[placeholder*='驗證碼' i]"
    ].join(",");
    const visualSelector = [
      "#captcha_img",
      "#captcha",
      "[id*='captcha' i]",
      "[class*='captcha' i]",
      "[name*='captcha' i]",
      "[id*='verify' i]",
      "[class*='verify' i]",
      "[name*='verify' i]",
      "[id*='valid' i]",
      "[class*='valid' i]",
      "[name*='valid' i]",
      "img[src*='captcha' i]",
      "img[id*='captcha' i]",
      "img[class*='captcha' i]",
      "canvas[id*='captcha' i]",
      "canvas[class*='captcha' i]"
    ].join(",");

    for (const [index, scope] of this.allScopes().entries()) {
      const target = await scope.locator("body").evaluate((body, selectors) => {
        const isVisible = (element: Element) => {
          const html = element as HTMLElement;
          const style = window.getComputedStyle(html);
          const rect = html.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const candidateLabel = (element: Element) => {
          const html = element as HTMLElement;
          return String(html.id || html.getAttribute("name") || html.getAttribute("class") || html.getAttribute("placeholder") || html.getAttribute("src") || html.textContent || html.tagName.toLowerCase());
        };
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(selectors.inputSelector))
          .filter((element) => isVisible(element));
        const input = inputs.find((element) => !element.disabled && !element.readOnly) || inputs[0];
        const visual = input || Array.from(document.querySelectorAll<HTMLElement>(selectors.visualSelector))
          .find((element) => isVisible(element));
        const labelTarget = (() => {
          const labelElements = Array.from(document.querySelectorAll<HTMLElement>("label,td,th,span,div,p,strong"))
            .filter((element) => isVisible(element))
            .filter((element) => /驗證碼|验证码|captcha|verification code/i.test(element.textContent || ""))
            .sort((a, b) => {
              const aArea = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
              const bArea = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
              return aArea - bArea;
            });
          const label = labelElements[0];
          if (!label) return null;

          const labelRect = label.getBoundingClientRect();
          const relatedContainer = label.closest("tr, li, label, .wwgrp, .form-group, .form-row, .field, div") || label.parentElement || label;
          const localCandidate = Array.from(relatedContainer.querySelectorAll<HTMLElement>("input:not([type='hidden']), img, canvas"))
            .filter((element) => isVisible(element))
            .find((element) => {
              const rect = element.getBoundingClientRect();
              return rect.top >= labelRect.top - 80 && rect.top <= labelRect.bottom + 140;
            });
          if (localCandidate) return localCandidate;

          const pageCandidates = Array.from(document.querySelectorAll<HTMLElement>("input:not([type='hidden']), img, canvas"))
            .filter((element) => isVisible(element))
            .map((element) => ({
              element,
              distance: Math.abs((element.getBoundingClientRect().top + element.getBoundingClientRect().bottom) / 2 - (labelRect.top + labelRect.bottom) / 2)
            }))
            .sort((a, b) => a.distance - b.distance);
          return pageCandidates[0]?.element || label;
        })();
        const target = input || visual || labelTarget;
        if (!target || !document.documentElement) {
          return null;
        }

        const container = target.closest("tr, li, label, .wwgrp, .form-group, .form-row, .field, div") || target;
        container.scrollIntoView({ block: "center", inline: "center" });
        target.scrollIntoView({ block: "center", inline: "center" });
        const rect = target.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        if (input) {
          input.focus({ preventScroll: true });
          return {
            kind: "input",
            label: candidateLabel(input),
            centerX,
            centerY
          };
        }
        const fallbackInput = target.matches("input:not([type='hidden'])") ? target as HTMLInputElement : null;
        if (fallbackInput && !fallbackInput.disabled && !fallbackInput.readOnly) {
          fallbackInput.focus({ preventScroll: true });
          return {
            kind: "input",
            label: candidateLabel(fallbackInput),
            centerX,
            centerY
          };
        }
        return {
          kind: "visual",
          label: candidateLabel(target),
          centerX,
          centerY
        };
      }, { inputSelector, visualSelector }).catch(() => "");

      if (target && typeof target === "object") {
        const clickPoint = index === 0
          ? await page.evaluate((point) => {
            const y = window.scrollY + point.centerY - window.innerHeight / 2;
            window.scrollTo({ top: Math.max(0, y), behavior: "auto" });
            document.documentElement.focus();
            const nextY = Math.min(Math.max(point.centerY, 8), window.innerHeight - 8);
            const nextX = Math.min(Math.max(point.centerX, 8), window.innerWidth - 8);
            return { x: nextX, y: nextY };
          }, target)
          : await page.locator("#iframe").first().evaluate((iframe, point) => {
            const rect = iframe.getBoundingClientRect();
            const y = window.scrollY + rect.top + point.centerY - window.innerHeight / 2;
            window.scrollTo({ top: Math.max(0, y), behavior: "auto" });
            document.documentElement.focus();
            const updatedRect = iframe.getBoundingClientRect();
            const nextX = Math.min(Math.max(updatedRect.left + point.centerX, 8), window.innerWidth - 8);
            const nextY = Math.min(Math.max(updatedRect.top + point.centerY, 8), window.innerHeight - 8);
            return { x: nextX, y: nextY };
        }, target);

        await page.waitForTimeout(150).catch(() => undefined);
        await this.markAutomationAction();
        await page.mouse.click(clickPoint.x, clickPoint.y).catch(() => undefined);
        await page.waitForTimeout(120).catch(() => undefined);
        await this.saveViewportScreenshot("captcha-centered");
        await this.logger.result(`已将验证码${target.kind === "input" ? "输入框" : "区域"}滚动到视觉中心并${target.kind === "input" ? "点击聚焦" : "显示"}：${index === 0 ? "主页面" : `iframe-${index}`} ${target.kind}:${target.label}`);
        return;
      }
    }

    const fallbackPoint = await this.findHumanVerificationFallbackPoint();
    if (fallbackPoint) {
      const clickPoint = await page.locator("#iframe").first().evaluate((iframe, point) => {
        const rect = iframe.getBoundingClientRect();
        const y = window.scrollY + rect.top + point.centerY - window.innerHeight / 2;
        window.scrollTo({ top: Math.max(0, y), behavior: "auto" });
        document.documentElement.focus();
        const updatedRect = iframe.getBoundingClientRect();
        return {
          x: Math.min(Math.max(updatedRect.left + point.centerX, 8), window.innerWidth - 8),
          y: Math.min(Math.max(updatedRect.top + point.centerY, 8), window.innerHeight - 8)
        };
      }, fallbackPoint).catch(() => undefined);
      if (clickPoint) {
        await page.waitForTimeout(150).catch(() => undefined);
        await this.markAutomationAction();
        await page.mouse.click(clickPoint.x, clickPoint.y).catch(() => undefined);
        await page.waitForTimeout(120).catch(() => undefined);
        await this.saveViewportScreenshot("captcha-fallback-targeted");
        await this.logger.result(`未找到验证码标准属性，已按页面上下文居中到验证码附近：${fallbackPoint.label}`);
        return;
      }
    }

    await this.logger.result("未找到可自动居中的验证码输入框或区域");
  }

  private async centerKnownCaptchaInput(): Promise<boolean> {
    const page = this.requirePage();
    const selector = [
      "#eAAOForm_captcha_field",
      "input[name='captcha']",
      "input.captcha",
      "input[id*='captcha' i]",
      "input[name*='captcha' i]",
      "input[class*='captcha' i]"
    ].join(",");

    for (const frame of page.frames().filter((item) => item !== page.mainFrame())) {
      const inputs = frame.locator(selector);
      const count = await inputs.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const input = inputs.nth(index);
        const usable = await input.evaluate((node) => {
          const element = node as HTMLInputElement;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return {
            visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
            disabled: element.disabled,
            readonly: element.readOnly,
            id: element.id || "",
            name: element.name || "",
            type: element.type || "text"
          };
        }).catch(() => undefined);
        if (!usable?.visible || usable.disabled || usable.readonly) continue;

        await input.scrollIntoViewIfNeeded().catch(() => undefined);
        const clickPoint = await this.centerLocatorInViewport(input);
        if (clickPoint) {
          await this.markAutomationAction();
          await page.mouse.click(clickPoint.x, clickPoint.y).catch(() => undefined);
        }
        await input.focus().catch(() => undefined);
        await this.saveViewportScreenshot("captcha-known-input-centered");
        await this.logger.result(`已将 BOCHK 验证码输入框滚动到视觉中心并聚焦：id=${usable.id || "无"} name=${usable.name || "无"} type=${usable.type} point=${clickPoint ? `${Math.round(clickPoint.x)},${Math.round(clickPoint.y)}` : "unknown"}`);
        return true;
      }
    }

    return false;
  }

  private async centerLastHumanVerificationInput(): Promise<boolean> {
    const page = this.requirePage();
    const editableSelector = [
      "input:visible:not([type='hidden']):not([type='radio']):not([type='checkbox']):not([type='submit']):not([type='button'])",
      "textarea:visible"
    ].join(",");

    for (const frame of page.frames().filter((item) => item !== page.mainFrame())) {
      const fields = frame.locator(editableSelector);
      const count = await fields.count().catch(() => 0);
      if (count === 0) continue;
      const field = fields.nth(count - 1);
      const meta = await field.evaluate((node) => {
        const input = node as HTMLInputElement | HTMLTextAreaElement;
        return {
          id: input.id || "",
          name: input.getAttribute("name") || "",
          type: input.getAttribute("type") || "",
          value: input.value || "",
          disabled: input.hasAttribute("disabled"),
          readonly: input.hasAttribute("readonly")
        };
      }).catch(() => undefined);
      if (!meta || meta.disabled || meta.readonly) continue;

      await field.scrollIntoViewIfNeeded().catch(() => undefined);
      const clickPoint = await this.centerLocatorInViewport(field);
      if (clickPoint) {
        await this.markAutomationAction();
        await page.mouse.click(clickPoint.x, clickPoint.y).catch(() => undefined);
      }
      await field.focus().catch(() => undefined);
      await this.saveViewportScreenshot("captcha-input-centered");
      await this.logger.result(`已将验证码输入框滚动到视觉中心并聚焦：last-input id=${meta.id || "无"} name=${meta.name || "无"} type=${meta.type || "text"} point=${clickPoint ? `${Math.round(clickPoint.x)},${Math.round(clickPoint.y)}` : "unknown"}`);
      return true;
    }

    return false;
  }

  private async findHumanVerificationFallbackPoint(): Promise<{ centerX: number; centerY: number; label: string } | undefined> {
    const page = this.requirePage();
    const frames = page.frames().filter((frame) => frame !== page.mainFrame());
    for (const frame of frames) {
      const point = await frame.locator("body").evaluate((body) => {
        const isVisible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const rect = html.getBoundingClientRect();
          const style = window.getComputedStyle(html);
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const centerOf = (element: Element, label: string) => {
          const rect = element.getBoundingClientRect();
          return {
            centerX: rect.left + rect.width / 2,
            centerY: rect.top + rect.height / 2,
            label
          };
        };
        const verificationText = /驗證碼|验证码|請輸入驗證碼|请输入验证码|captcha|verification code/i;
        const textNodes = Array.from(body.querySelectorAll<HTMLElement>("label,td,th,span,div,p,strong"))
          .filter((element) => isVisible(element))
          .filter((element) => verificationText.test(element.textContent || ""))
          .sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            return aRect.top - bRect.top;
          });

        for (const label of textNodes) {
          const labelRect = label.getBoundingClientRect();
          const nearby = Array.from(body.querySelectorAll<HTMLElement>("input:not([type='hidden']), img, canvas"))
            .filter((element) => isVisible(element))
            .map((element) => {
              const rect = element.getBoundingClientRect();
              const centerY = rect.top + rect.height / 2;
              return {
                element,
                distance: Math.abs(centerY - (labelRect.top + labelRect.height / 2)),
                belowPenalty: centerY < labelRect.top - 40 ? 500 : 0
              };
            })
            .sort((a, b) => (a.distance + a.belowPenalty) - (b.distance + b.belowPenalty))[0]?.element;
          if (nearby) return centerOf(nearby, `near text: ${(label.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60)}`);
          return centerOf(label, `text: ${(label.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60)}`);
        }

        const editableInputs = Array.from(body.querySelectorAll<HTMLInputElement>("input:not([type='hidden']):not([type='radio']):not([type='checkbox']):not([type='submit']):not([type='button'])"))
          .filter((element) => isVisible(element) && !element.disabled && !element.readOnly);
        const lastInput = editableInputs[editableInputs.length - 1];
        if (lastInput) return centerOf(lastInput, `last editable input: ${lastInput.id || lastInput.name || lastInput.type || "input"}`);

        const bodyRect = body.getBoundingClientRect();
        return {
          centerX: Math.max(24, Math.min(window.innerWidth / 2, bodyRect.width - 24)),
          centerY: Math.max(24, Math.min(body.scrollHeight * 0.72, body.scrollHeight - 24)),
          label: "frame 72% fallback"
        };
      }).catch(() => undefined);

      if (point) return point;
    }
    return undefined;
  }

  private async centerLocatorInViewport(locator: Locator): Promise<{ x: number; y: number } | undefined> {
    const page = this.requirePage();
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(120).catch(() => undefined);

    let box = await locator.boundingBox().catch(() => null);
    if (!box) return undefined;

    await page.evaluate((centerY) => {
      const targetTop = window.scrollY + centerY - window.innerHeight * 0.48;
      window.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
    }, box.y + box.height / 2).catch(() => undefined);
    await page.waitForTimeout(180).catch(() => undefined);

    box = await locator.boundingBox().catch(() => null);
    if (!box) return undefined;

    return {
      x: Math.min(Math.max(box.x + box.width / 2, 8), 1350),
      y: Math.min(Math.max(box.y + box.height / 2, 8), 885)
    };
  }

  private async saveViewportScreenshot(name: string): Promise<void> {
    const page = this.requirePage();
    const path = resolve("debug", `viewport-${this.logger.taskId}-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await mkdir("debug", { recursive: true }).catch(() => undefined);
    await page.screenshot({ path, fullPage: false }).then(async () => {
      await this.logger.result(`当前视口截图：${path}`);
    }).catch(async (error) => {
      await this.logger.result(`当前视口截图失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async clickContinueByText(): Promise<boolean> {
    const labels = ["遞交", "递交", "繼續", "继续", "下一步", "提交", "確認", "确认", "Confirm", "Submit", "Next"];
    for (const label of labels) {
      if (await this.clickByText(["button", "input[type='submit']", "input[type='button']", "a"], label)) {
        await this.logger.result(`点击继续/提交成功：${label}`);
        return true;
      }
    }
    return this.clickIfVisible(bochkSelectors.submit);
  }

  private async clickByText(tags: string[], label: string): Promise<boolean> {
    const selector = tags.join(",");
    const scopes = this.allScopes();
    for (const scope of scopes) {
      const locator = scope.locator(selector).filter({ hasText: new RegExp(escapeRegExp(label), "i") }).first();
      if (await locator.isVisible({ timeout: 1500 }).catch(() => false)) {
        await this.markAutomationAction();
        await locator.click();
        return true;
      }
      const input = scope.locator(`input[value*="${label}"]`).first();
      if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
        await this.markAutomationAction();
        await input.click();
        return true;
      }
    }
    return false;
  }

  private async submitConfirmationAndClassify(slot: Slot | undefined, retryCount: number): Promise<BookingResult> {
    const page = this.requirePage();
    await this.humanVerificationHooks.onStatus?.("final-submitting", "最终提交中：点击确认并等待结果");
    await this.clickContinueByText();
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(3000 + Math.min(2, retryCount) * 1000);

    const result = await this.classifyFinalSubmitResult();
    await this.logger.result(`最终提交结果判断：${result}`);
    if (result === "SUCCESS") {
      const booked = await this.extractResultAndFinish(slot);
      if (booked) {
        return booked;
      }
      return { status: "needs-human", reason: "检测到成功关键词，但未能提取预约编号，已保留浏览器现场。" };
    }
    if (result === "SLOT_FULL") {
      await this.humanVerificationHooks.onStatus?.("slot-full-scanning", "号源已满继续扫描");
      await this.logger.result("当前 slot 已满，准备尝试返回选择页选择下一个可接受时段");
      return { status: "no-slot", reason: "当前 slot 已满，将尝试其他可接受时段。" };
    }
    if (result === "VALIDATION_ERROR") {
      await this.saveFullDiagnosis("validation-error");
      return { status: "needs-human", reason: "页面出现必填/格式错误，已截图并保存错误文本，浏览器保持打开。" };
    }
    if (result === "CAPTCHA") {
      await this.waitForManualCaptcha();
      return { status: "no-slot", reason: "验证码处理后继续状态机。" };
    }
    if (result === "TIMEOUT") {
      if (slot ?? this.latestSlot) {
        await this.saveFullDiagnosis("locked-slot-submit-timeout");
        return {
          status: "needs-human",
          reason: "已锁定号源并提交后仍未识别确认/成功结果，已保留现场，不再返回重选。",
        };
      }
      await this.saveFullDiagnosis("submit-timeout");
      return { status: "no-slot", reason: "提交后暂未识别明确结果，准备重试。" };
    }

    await this.saveFullDiagnosis("submit-unknown");
    return { status: "needs-human", reason: "提交后无法识别页面结果，已保存诊断并保留现场。" };
  }

  private async classifyFinalSubmitResult(): Promise<SubmitResultType> {
    const text = await this.visibleText();
    if (/captcha|verify|challenge|驗證碼|验证码|人機驗證|人机验证/i.test(text)) return "CAPTCHA";
    if (hasSuccessPageSignal(text)) return "SUCCESS";
    if (hasTimeoutPageSignal(text)) return "TIMEOUT";
    if (/已滿|已满|名額已滿|名额已满|沒有可供預約時段|没有可供预约时段|no available slot|fully booked/i.test(text)) return "SLOT_FULL";
    if (/請輸入|请输入|必須填寫|必须填写|格式不正確|格式不正确|invalid|required|error/i.test(text)) return "VALIDATION_ERROR";
    const type = await this.detectCurrentPageType();
    if (type === "SUCCESS") return "SUCCESS";
    if (type === "CAPTCHA") return "CAPTCHA";
    return "TIMEOUT";
  }

  private async finishTerminalPageIfPresent(slot: Slot | undefined): Promise<BookingResult | undefined> {
    const terminalType = await this.detectTerminalPageType();
    if (!terminalType) {
      return undefined;
    }

    if (terminalType === "SUCCESS") {
      this.lastStep = "第三页成功页：提取预约结果";
      await this.logger.result("检测到第三页成功页，停止后续自动化并提取预约结果。");
      const result = await this.extractResultAndFinish(slot ?? this.latestSlot);
      if (result) {
        return result;
      }
      await this.saveFullDiagnosis("success-without-reference");
      return { status: "needs-human", reason: "检测到预约成功页，但没有提取到参考编号，已保存截图和页面文本。" };
    }

    this.lastStep = "第三页操作逾时";
    if (slot ?? this.latestSlot) {
      await this.logger.result("检测到第三页操作逾时/超时，但已有锁定号源；停止自动回退重选，保存诊断并保留现场。");
      await this.saveFullDiagnosis("locked-slot-third-page-timeout");
      return {
        status: "needs-human",
        reason: "已锁定号源后页面超时，已停止自动回退重选并保留浏览器现场，请人工检查是否有页面校验或提交提示。",
      };
    }
    await this.logger.result("检测到第三页操作逾时/超时，保存诊断后等待人工重新输入验证码。");
    await this.saveFullDiagnosis("third-page-timeout");
    await this.waitForHumanVerificationLoop("页面操作逾时，请重新输入验证码");
    return undefined;
  }

  private async detectTerminalPageType(): Promise<TerminalPageType | undefined> {
    for (const scope of this.allScopes()) {
      const text = await scope.locator("body").innerText({ timeout: 1500 }).catch(() => "");
      const fields = await scope.locator("input,select,textarea,button,a").evaluateAll((nodes) =>
        nodes.slice(0, 200).map((node) => {
          const element = node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement | HTMLAnchorElement;
          return [
            element.tagName,
            element.id || "",
            element.getAttribute("name") || "",
            element.getAttribute("placeholder") || "",
            element.textContent || "",
            (element as HTMLInputElement).value || ""
          ].join(" ");
        }).join("\n")
      ).catch(() => "");
      const haystack = `${scope.url()} ${text}\n${fields}`;
      if (hasSuccessPageSignal(haystack)) return "SUCCESS";
      if (hasTimeoutPageSignal(haystack)) return "TIMEOUT";
    }

    return undefined;
  }

  private async extractResultAndFinish(slot: Slot | undefined): Promise<BookingResult | undefined> {
    if (this.thirdPageProcessed) {
      await this.logger.result("成功页已处理过，跳过重复截图和解析。");
      return undefined;
    }
    this.thirdPageProcessed = true;

    const page = this.requirePage();
    const text = await this.visibleText();
    const successScreenshotPath = await this.saveSuccessScreenshot();
    const details = extractSuccessDetails(text, slot, this.request.customer, successScreenshotPath);
    const reference = details.referenceNumber;
    if (!reference) {
      await this.saveSuccessText(text);
      return undefined;
    }
    const extractedSlot = {
      branch: details.branch || slot?.branch || "未识别分行",
      district: details.district || slot?.district,
      date: details.appointmentDate || slot?.date || "未识别日期",
      time: details.appointmentTime || slot?.time || "未识别时间"
    };
    await this.logger.result(`成功页解析完成：参考编号 ${reference}`);
    await page.waitForTimeout(200);
    return {
      status: "booked",
      confirmationText: text,
      slot: extractedSlot,
      referenceNumber: reference,
      details
    };
  }

  private async saveSuccessScreenshot(): Promise<string | undefined> {
    const taskId = this.options.taskId;
    if (!taskId) {
      return this.logger.screenshot(this.requirePage(), "step", "success");
    }
    const relativePath = `records/task-${taskId}/success.png`;
    const absolutePath = resolve(relativePath);
    await mkdir(resolve("records", `task-${taskId}`), { recursive: true });
    await this.requirePage().screenshot({ path: absolutePath, fullPage: true }).catch(async (error) => {
      await this.logger.result(`成功页截图保存失败：${error instanceof Error ? error.message : String(error)}`);
    });
    await this.logger.result(`成功页截图已保存：${absolutePath}`);
    return relativePath;
  }

  private async saveSuccessText(text: string): Promise<void> {
    const taskId = this.options.taskId;
    const dir = taskId ? resolve("records", `task-${taskId}`) : resolve("debug");
    await mkdir(dir, { recursive: true });
    const path = resolve(dir, `success-page-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
    await writeFile(path, `${text}\n`);
    await this.logger.result(`成功页文本已保存：${path}`);
  }

  private async tryReturnToSlotSelection(): Promise<void> {
    if (await this.clickByText(["button", "a", "input[type='button']"], "返回")) return;
    if (await this.clickByText(["button", "a", "input[type='button']"], "上一步")) return;
    await this.requirePage().goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await this.requirePage().waitForTimeout(1200);
  }

  private async fillLikelyDocumentNumber(): Promise<void> {
    const value = this.request.customer.phone.slice(-4);
    const selectors = [
      "input[name*='id'][type='text']",
      "input[id*='id'][type='text']",
      "input[name*='document'][type='text']",
      "input[id*='document'][type='text']",
      "input[name*='identity'][type='text']",
      "input[id*='identity'][type='text']"
    ];
    for (const selector of selectors) {
      const locator = await this.firstEmptyVisibleLocator(selector);
      if (locator) {
        await locator.fill(value);
        await this.logger.result(`自动填写证件号码/尾号候选字段：${selector}`);
      }
    }
  }

  private async fillOtherRequiredFields(): Promise<void> {
    for (const scope of this.allScopes()) {
      const fields = scope.locator("input:visible,textarea:visible");
      const count = await fields.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const field = fields.nth(index);
        const meta = await field.evaluate((node) => {
          const input = node as HTMLInputElement | HTMLTextAreaElement;
          return {
            value: input.value,
            type: input.getAttribute("type") || "",
            name: input.getAttribute("name") || "",
            id: input.id || "",
            placeholder: input.getAttribute("placeholder") || "",
            required: input.required || input.getAttribute("aria-required") === "true",
            label: input.id ? document.querySelector(`label[for="${input.id}"]`)?.textContent?.trim() || "" : ""
          };
        }).catch(() => undefined);
        if (!meta || meta.value || /hidden|submit|button|radio|checkbox|file/i.test(meta.type)) continue;
        const haystack = `${meta.name} ${meta.id} ${meta.placeholder} ${meta.label}`;
        const value = inferFieldValue(haystack, this.request.customer);
        if (value && (meta.required || /請輸入|请输入|必填|required|電話|手机|手機|email|mail|姓名|姓氏|名字|證件|证件|id/i.test(haystack))) {
          await field.fill(value).catch(() => undefined);
          await this.logger.result(`自动填写额外必填字段：${haystack.slice(0, 80)}`);
        }
      }
    }
  }

  private async firstEmptyVisibleLocator(selector: string): Promise<Locator | undefined> {
    for (const scope of this.allScopes()) {
      const locators = scope.locator(selector);
      const count = await locators.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const locator = locators.nth(index);
        if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
          const value = await locator.evaluate((node) => (node as HTMLInputElement).value).catch(() => "");
          if (!value) return locator;
        }
      }
    }
    return undefined;
  }

  private async hasVisibleLocator(selector: string, timeout = 1000): Promise<boolean> {
    for (const scope of this.allScopes()) {
      const locators = scope.locator(selector);
      const count = await locators.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        if (await locators.nth(index).isVisible({ timeout }).catch(() => false)) {
          return true;
        }
      }
    }
    return false;
  }

  private allScopes(): Array<Page | Frame> {
    const page = this.requirePage();
    return [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
  }

  private async installManualOverrideDetector(): Promise<void> {
    for (const scope of this.allScopes()) {
      await scope.evaluate(() => {
        const state = window as typeof window & {
          __bochkManualOverrideInstalled?: boolean;
          __bochkManualOverride?: boolean;
          __bochkManualOverrideEvent?: string;
          __bochkManualOverrideAt?: string;
          __bochkAutomationIgnoreUntil?: number;
        };
        if (state.__bochkManualOverrideInstalled) return;
        state.__bochkManualOverrideInstalled = true;
        state.__bochkManualOverride = false;
        state.__bochkAutomationIgnoreUntil = 0;

        const markManualOverride = (event: Event) => {
          if (Date.now() < (state.__bochkAutomationIgnoreUntil ?? 0)) return;
          state.__bochkManualOverride = true;
          state.__bochkManualOverrideEvent = event.type;
          state.__bochkManualOverrideAt = new Date().toISOString();
        };

        for (const eventName of ["mousedown", "pointerdown", "keydown", "wheel", "touchstart"]) {
          window.addEventListener(eventName, markManualOverride, { capture: true, passive: true });
        }
      }).catch(() => undefined);
    }
  }

  private async markAutomationAction(ms = 1500): Promise<void> {
    await this.installManualOverrideDetector();
    for (const scope of this.allScopes()) {
      await scope.evaluate((ignoreMs) => {
        const state = window as typeof window & { __bochkAutomationIgnoreUntil?: number };
        state.__bochkAutomationIgnoreUntil = Date.now() + ignoreMs;
      }, ms).catch(() => undefined);
    }
  }

  private async clearManualOverrideFlag(): Promise<void> {
    for (const scope of this.allScopes()) {
      await scope.evaluate(() => {
        const state = window as typeof window & {
          __bochkManualOverride?: boolean;
          __bochkManualOverrideEvent?: string;
          __bochkManualOverrideAt?: string;
        };
        state.__bochkManualOverride = false;
        state.__bochkManualOverrideEvent = undefined;
        state.__bochkManualOverrideAt = undefined;
      }).catch(() => undefined);
    }
  }

  private async readManualOverride(): Promise<{ event?: string; at?: string; url?: string } | undefined> {
    for (const scope of this.allScopes()) {
      const override = await scope.evaluate(() => {
        const state = window as typeof window & {
          __bochkManualOverride?: boolean;
          __bochkManualOverrideEvent?: string;
          __bochkManualOverrideAt?: string;
        };
        if (!state.__bochkManualOverride) return undefined;
        return {
          event: state.__bochkManualOverrideEvent,
          at: state.__bochkManualOverrideAt,
          url: window.location.href
        };
      }).catch(() => undefined);
      if (override) return override;
    }
    return undefined;
  }

  private async stopIfManualOverride(): Promise<BookingResult | undefined> {
    const override = await this.readManualOverride();
    if (!override) return undefined;

    const reason = `检测到用户接管浏览器（${override.event ?? "unknown"} ${override.at ?? ""}），已停止自动化并保留现场。`;
    this.lastStep = reason;
    await this.logger.result(reason);
    await this.humanVerificationHooks.onStatus?.("needs-human", "检测到用户接管，已暂停自动化，请手动处理");
    await this.saveFullDiagnosis("manual-override");
    return {
      status: "needs-human",
      reason
    };
  }

  private async visibleText(): Promise<string> {
    const chunks = await Promise.all(this.allScopes().map((scope) =>
      scope.locator("body").innerText({ timeout: 2000 }).catch(() => "")
    ));
    return chunks.join("\n").slice(0, 20000);
  }

  private async saveFullDiagnosis(name: string): Promise<void> {
    const page = this.requirePage();
    await this.logger.diagnosePage(page, name);
    await this.logger.screenshot(page, "fail", name);
    const path = resolve("debug", `page-diagnosis-${this.logger.taskId}-${Date.now()}.txt`);
    const diagnosis = await buildPageDiagnosis(page);
    await writeFile(path, diagnosis);
    await this.logger.result(`完整页面诊断已保存：${path}`);
  }

  private async hasCaptcha(): Promise<boolean> {
    const candidates = [
      this.requirePage().locator(bochkSelectors.captcha).first(),
      this.requirePage().frameLocator("#iframe").locator(bochkSelectors.captcha).first()
    ];
    for (const locator of candidates) {
      if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
        return true;
      }
    }
    return false;
  }

  private async captchaInputState(): Promise<{ visible: boolean; filled: boolean; label?: string }> {
    const selector = [
      "input[id*='captcha' i]",
      "input[name*='captcha' i]",
      "input[class*='captcha' i]",
      "input[id*='verify' i]",
      "input[name*='verify' i]",
      "input[id*='verification' i]",
      "input[name*='verification' i]",
      "input[placeholder*='验证码' i]",
      "input[placeholder*='驗證碼' i]"
    ].join(",");

    for (const scope of this.allScopes()) {
      const state = await scope.locator("body").evaluate((body, inputSelector) => {
        const isVisible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const rect = html.getBoundingClientRect();
          const style = window.getComputedStyle(html);
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const inputs = Array.from(body.querySelectorAll<HTMLInputElement>(inputSelector))
          .filter((input) => isVisible(input) && !input.disabled && !input.readOnly);
        const input = inputs[0];
        if (!input) return undefined;
        return {
          visible: true,
          filled: input.value.trim().length > 0,
          label: input.id || input.name || input.placeholder || input.className || "captcha-input"
        };
      }, selector).catch(() => undefined);

      if (state?.visible) {
        return state;
      }
    }

    return { visible: false, filled: false };
  }

  private async hasHumanVerification(): Promise<boolean> {
    await this.logger.step("检测验证码/人机验证", this.requirePage());
    const captchaInput = await this.captchaInputState();
    if (captchaInput.visible && captchaInput.filled) {
      await this.logger.result(`验证码输入框已有内容，视为已人工输入，不再重复暂停：${captchaInput.label ?? "captcha-input"}`);
      return false;
    }
    if (captchaInput.visible && !captchaInput.filled) {
      await this.logger.result(`检测到空验证码输入框：${captchaInput.label ?? "captcha-input"}`);
      return true;
    }
    if (await this.hasCaptcha()) {
      await this.logger.result("检测到 captcha selector");
      return true;
    }
    const findings = await this.collectHumanVerificationFindings();
    if (findings.length > 0) {
      await this.logger.result(`检测到验证码/人机验证线索：${findings.join(" | ")}`);
      await this.logger.screenshot(this.requirePage(), "fail", "human-verification");
      return true;
    }
    return false;
  }

  private async detectSecondPageHumanVerification(): Promise<BookingResult | undefined> {
    const findings = await this.collectHumanVerificationFindings();
    await this.logger.result(`[CAPTCHA] Second page verification findings: ${JSON.stringify(findings)}`);
    if (findings.length === 0) {
      return undefined;
    }

    this.lastStep = "第二页检测到验证码/人工验证，停止自动化操作";
    await this.logger.result("[CAPTCHA] Detected human verification required");
    await this.logger.screenshot(this.requirePage(), "fail", "second-page-human-verification");
    await this.humanVerificationHooks.onStatus?.("needs-human", "需要人工输入验证码 / 完成人工验证");
    await this.humanVerificationHooks.onWaiting?.("[CAPTCHA] Detected human verification required");
    return {
      status: "needs-human",
      reason: "[CAPTCHA] Detected human verification required"
    };
  }

  private async collectHumanVerificationFindings(): Promise<string[]> {
    const findings: string[] = [];
    const page = this.requirePage();
    const frameUrls = page.frames().slice(1).map((frame) => frame.url()).filter(Boolean);
    const matchedFrameUrls = frameUrls.filter((url) => /captcha|verify|verification|challenge|recaptcha|hcaptcha|arkose|geetest/i.test(url));
    if (matchedFrameUrls.length > 0) {
      findings.push(`captcha-like iframe url: ${matchedFrameUrls.join(" | ")}`);
    }

    for (const [index, scope] of this.allScopes().entries()) {
      const scopeLabel = index === 0 ? "page" : `frame-${index}`;
      const text = await scope.locator("body").innerText({ timeout: 1500 }).catch(() => "");
      if (/验证码|驗證碼|請輸入驗證碼|请输入验证码|人机验证|人機驗證|安全验证|安全驗證|拖動|拖动|滑块|滑塊|captcha|verification|verify|challenge/i.test(text)) {
        findings.push(`${scopeLabel}: visible text indicates verification`);
      }

      const elementMatches = await scope.locator([
        "[id*='captcha' i]",
        "[class*='captcha' i]",
        "[name*='captcha' i]",
        "[id*='verify' i]",
        "[class*='verify' i]",
        "[name*='verify' i]",
        "[id*='verification' i]",
        "[class*='verification' i]",
        "[name*='verification' i]",
        "[id*='challenge' i]",
        "[class*='challenge' i]",
        "[name*='challenge' i]",
        "[id*='slider' i]",
        "[class*='slider' i]",
        "[name*='slider' i]",
        "input[id*='code' i]",
        "input[class*='code' i]",
        "input[name*='code' i]",
        "input[placeholder*='验证码' i]",
        "input[placeholder*='驗證碼' i]",
        "input[placeholder*='captcha' i]",
        "img[src*='captcha' i]",
        "img[id*='captcha' i]",
        "img[class*='captcha' i]",
        "canvas[id*='captcha' i]",
        "canvas[class*='captcha' i]",
        "canvas[id*='verify' i]",
        "canvas[class*='verify' i]",
        "canvas[id*='challenge' i]",
        "canvas[class*='challenge' i]"
      ].join(",")).evaluateAll((nodes) =>
        nodes.map((node) => {
          const element = node as HTMLElement;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          if (!visible) return "";
          return [
            element.tagName.toLowerCase(),
            element.id ? `#${element.id}` : "",
            element.getAttribute("class") || "",
            element.getAttribute("name") || "",
            element.getAttribute("placeholder") || "",
            element.getAttribute("src") || "",
            `${Math.round(rect.width)}x${Math.round(rect.height)}`
          ].filter(Boolean).join(" ");
        }).filter(Boolean).slice(0, 20)
      ).catch(() => []);

      if (elementMatches.length > 0) {
        findings.push(`${scopeLabel}: captcha-like elements: ${elementMatches.join(" | ")}`);
      }
    }

    return findings;
  }

  private async selectFirstMatchingOption(
    selector: string,
    preferredLabels: string[],
    matchOptions: { skipFull?: boolean } = {}
  ): Promise<string | undefined> {
    if (preferredLabels.length === 0) {
      return undefined;
    }

    const locator = await this.firstVisibleLocator(selector) ?? await this.findSelectByText(preferredLabels.join(" "));
    if (!locator) {
      await this.logger.selector("选择失败，找不到 selector", selector);
      return undefined;
    }

    const selectOptions = await locator.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: node.textContent?.trim() ?? "",
        value: (node as HTMLOptionElement).value,
        disabled: (node as HTMLOptionElement).disabled
      }))
    );
    const match = selectOptions.find((option) =>
      option.value
      && !option.disabled
      && (!matchOptions.skipFull || !/已滿|已满|full/i.test(option.label))
      && preferredLabels.some((label) => option.label.toLowerCase().includes(label.toLowerCase()))
    );
    if (!match) {
      await this.logger.result(`选择失败：找不到匹配选项 ${preferredLabels.join(", ")}`);
      return undefined;
    }

    await this.markAutomationAction();
    await locator.selectOption(match.value);
    await this.logger.result(`选择成功：${match.label}`);
    return match.label;
  }

  private async selectFirstMatchingOptionFromLocator(
    locator: Locator | undefined,
    preferredLabels: string[],
    fieldName: string,
    matchOptions: { skipFull?: boolean } = {}
  ): Promise<string | undefined> {
    if (!locator) {
      await this.logger.result(`选择失败：找不到 ${fieldName} 下拉框`);
      return undefined;
    }
    if (preferredLabels.length === 0) {
      return undefined;
    }

    const selectOptions = await this.readSelectOptions(locator);
    const match = selectOptions.find((option) =>
      option.value
      && !option.disabled
      && (!matchOptions.skipFull || !/已滿|已满|full/i.test(option.label))
      && preferredLabels.some((label) => optionLabelMatches(option, label))
    );
    if (!match) {
      await this.logger.result(`选择失败：${fieldName} 找不到匹配选项 ${preferredLabels.join(", ")}`);
      return undefined;
    }

    await this.markAutomationAction();
    await locator.selectOption(match.value);
    await this.logger.result(`选择成功：${fieldName} -> ${match.label}`);
    return match.label || match.value;
  }

  private async selectOptionByValueOrLabel(
    selector: string,
    preferredValue: string | undefined,
    preferredLabel: string
  ): Promise<boolean> {
    const locator = await this.firstVisibleLocator(selector) ?? await this.findSelectByText(preferredLabel);
    if (!locator) {
      await this.logger.selector("选择失败，找不到 selector", selector);
      return false;
    }

    if (preferredValue) {
      await this.markAutomationAction();
      await locator.selectOption(preferredValue).catch(() => undefined);
      const selectedValue = await locator.evaluate((select) => (select as HTMLSelectElement).value).catch(() => "");
      if (selectedValue === preferredValue) {
        await this.logger.result(`选择成功：${preferredLabel} -> ${preferredValue}`);
        return true;
      }
    }

    const label = await this.selectFirstMatchingOption(selector, [preferredLabel]);
    return Boolean(label);
  }

  private async selectFirstAvailableOption(selector: string): Promise<string | undefined> {
    const locator = await this.firstVisibleLocator(selector) ?? await this.findSelectByText(selector);
    if (!locator) {
      await this.logger.selector("等待失败，找不到 selector", selector);
      return undefined;
    }

    const options = await locator.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: node.textContent?.trim() ?? "",
        value: (node as HTMLOptionElement).value,
        disabled: (node as HTMLOptionElement).disabled
      }))
    );
    const option = options.find((item) => item.value && !item.disabled && !/請選|请选择|select/i.test(item.label));
    if (!option) {
      await this.logger.result("选择失败：没有可用选项");
      return undefined;
    }

    await this.markAutomationAction();
    await locator.selectOption(option.value);
    await this.logger.result(`选择成功：${option.label}`);
    return option.label;
  }

  private async selectFirstAvailableOptionFromLocator(
    locator: Locator | undefined,
    fieldName: string,
    matchOptions: { skipFull?: boolean } = {}
  ): Promise<string | undefined> {
    if (!locator) {
      await this.logger.result(`选择失败：找不到 ${fieldName} 下拉框`);
      return undefined;
    }
    const options = await this.readSelectOptions(locator);
    const option = options.find((item) =>
      item.value
      && !item.disabled
      && !/請選|请选择|select/i.test(item.label)
      && (!matchOptions.skipFull || !/已滿|已满|full/i.test(item.label))
    );
    if (!option) {
      await this.logger.result(`选择失败：${fieldName} 没有可用选项`);
      return undefined;
    }
    await this.markAutomationAction();
    await locator.selectOption(option.value);
    await this.logger.result(`选择成功：${fieldName} -> ${option.label}`);
    return option.label || option.value;
  }

  private async selectOptionByContext(contextPattern: RegExp, optionPattern: RegExp, fieldName: string): Promise<string | undefined> {
    for (const scope of this.allScopes()) {
      const selects = scope.locator("select:visible");
      const count = await selects.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const select = selects.nth(index);
        const meta = await select.evaluate((node) => {
          const element = node as HTMLSelectElement;
          const label = element.id ? document.querySelector(`label[for="${element.id}"]`)?.textContent?.trim() || "" : "";
          const parentText = element.parentElement?.textContent?.trim() || "";
          const previousText = element.previousElementSibling?.textContent?.trim() || "";
          const options = Array.from(element.options).map((option) => ({
            label: option.textContent?.trim() || "",
            value: option.value,
            disabled: option.disabled
          }));
          return {
            text: `${element.name} ${element.id} ${label} ${parentText} ${previousText} ${options.map((option) => `${option.label} ${option.value}`).join(" ")}`,
            options
          };
        }).catch(() => undefined);
        if (!meta || !contextPattern.test(meta.text)) continue;
        const option = meta.options.find((item) => item.value && !item.disabled && optionPattern.test(`${item.label} ${item.value}`));
        if (!option) continue;
        await this.markAutomationAction();
        await select.selectOption(option.value);
        await this.logger.result(`选择成功：${fieldName} -> ${option.label || option.value}`);
        return option.label || option.value;
      }
    }
    await this.logger.result(`选择失败：找不到 ${fieldName}`);
    return undefined;
  }

  private async selectOptionByVisibleOption(optionPattern: RegExp, fieldName: string): Promise<string | undefined> {
    for (const scope of this.allScopes()) {
      const selects = scope.locator("select:visible");
      const count = await selects.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const select = selects.nth(index);
        const options = await this.readSelectOptions(select);
        const option = options.find((item) =>
          item.value
          && !item.disabled
          && optionPattern.test(`${item.label} ${item.value}`)
        );
        if (!option) continue;
        await this.markAutomationAction();
        await select.selectOption(option.value);
        await this.logger.result(`选择成功：${fieldName} -> ${option.label || option.value}`);
        return option.label || option.value;
      }
    }
    await this.logger.result(`选择失败：所有可见下拉框都没有 ${fieldName} 选项`);
    return undefined;
  }

  private async selectCountryCodeRadio(countryCode: string): Promise<boolean> {
    const normalizedCode = countryCode.replace(/\D/g, "") || "86";
    for (const scope of this.allScopes()) {
      const radio = scope.locator([
        `#openMCaccount_countryNo_radio${normalizedCode}`,
        `input[type='radio'][value='${normalizedCode}'][id*='countryNo']`,
        `input[type='radio'][value='${normalizedCode}'][name*='backUp']`
      ].join(",")).first();
      if (await radio.count().catch(() => 0) === 0) continue;

      await this.markAutomationAction();
      await radio.check({ force: true }).catch(async () => {
        await radio.evaluate((node) => {
          (window as typeof window & { __bochkAutomationIgnoreUntil?: number }).__bochkAutomationIgnoreUntil = Date.now() + 1500;
          const input = node as HTMLInputElement;
          input.checked = true;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.click();
        }).catch(() => undefined);
      });

      for (const selector of ["input[name='bean.countryNo']", "#test01", "#openMCaccount_countryNo_field"]) {
        await scope.locator(selector).first().evaluate((node, value) => {
          const input = node as HTMLInputElement;
          input.value = String(value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, normalizedCode).catch(() => undefined);
      }

      await this.logger.result(`选择成功：國家/區域編號 -> ${normalizedCode} 中國內地`);
      return true;
    }

    await this.logger.result(`选择失败：找不到國家/區域編號 radio ${normalizedCode}`);
    return false;
  }

  private async readCalendarDateOptions(openIfNeeded = false): Promise<string[]> {
    if (openIfNeeded) {
      await this.openCalendarControls();
    }
    const options: string[] = [];
    for (const scope of this.allScopes()) {
      const dates = await scope.locator("body").evaluate(() => {
        const parseRgbValue = (value: string): { r: number; g: number; b: number } | undefined => {
          const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
          if (!match) return undefined;
          return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
        };
        const isVisible = (element: HTMLElement): boolean => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0;
        };
        const dateMeta = (element: HTMLElement): { text: string; available: boolean } => {
          const text = element.textContent?.trim() || "";
          if (!/^\d{1,2}$/.test(text) || !isVisible(element)) {
            return { text, available: false };
          }

          const className = element.className.toString().toLowerCase();
          const parentClassName = element.parentElement?.className.toString().toLowerCase() || "";
          const style = window.getComputedStyle(element);
          const color = parseRgbValue(style.color);
          const isDisabled = element.getAttribute("aria-disabled") === "true"
            || element.hasAttribute("disabled")
            || /disabled|unavailable|inactive|off|grey|gray|full|non|not|unselectable/.test(`${className} ${parentClassName}`)
            || style.pointerEvents === "none"
            || Number(style.opacity || "1") < 0.55;
          if (isDisabled) return { text, available: false };

          const isClickable = Boolean(
            element.closest("a,button,[role='button']")
            || element.getAttribute("onclick")
            || element.querySelector("a,button,[role='button']")
          );
          const isJQueryUiDate = Boolean(
            element.closest(".ui-datepicker-calendar")
            && (
              element.matches("a.ui-state-default")
              || element.querySelector("a.ui-state-default")
              || element.closest("td")?.querySelector("a.ui-state-default")
            )
          );
          const isDarkBlue = color ? color.b >= color.r + 25 && color.b >= color.g + 10 && color.r < 100 : false;
          const isNotGrey = color ? Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) > 35 : true;
          return { text, available: isJQueryUiDate || isClickable || (isDarkBlue && isNotGrey) };
        };

        const dateLinks = Array.from(document.querySelectorAll(".ui-datepicker-calendar td:not(.ui-datepicker-unselectable) a.ui-state-default"))
          .filter((node) => isVisible(node as HTMLElement))
          .map((node) => node.textContent?.trim() || "")
          .filter((text) => /^\d{1,2}$/.test(text));
        if (dateLinks.length > 0) {
          return dateLinks;
        }

        return Array.from(document.querySelectorAll("td,a,button,span,div,[role='button']"))
          .map((node) => dateMeta(node as HTMLElement))
          .filter((meta) => meta.available)
          .map((meta) => meta.text);
      }).catch(() => []);
      options.push(...dates);
    }
    const uniqueDates = [...new Set(options)];
    await this.logger.result(`读取日历可预约日期：${uniqueDates.join(", ") || "无"}`);
    return uniqueDates;
  }

  private async findCalendarDateLocator(): Promise<Locator | undefined> {
    for (const scope of this.allScopes()) {
      const locator = scope.locator("a,button,[role='button']").filter({ hasText: /^\d{1,2}$/ }).first();
      if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
        return locator;
      }
    }
    return undefined;
  }

  private async clickFirstAvailableCalendarDate(): Promise<string | undefined> {
    const dates = await this.readCalendarDateOptions(true);
    if (dates.length === 0) {
      await this.logger.result("选择日期失败：没有可点击日历日期");
      return undefined;
    }
    return this.clickCalendarDateByDay(dates[0]);
  }

  private async clickPreferredCalendarDate(preferredDates: string[]): Promise<string | undefined> {
    for (const preferredDate of preferredDates) {
      await this.navigateCalendarToPreferredDate(preferredDate);
      const day = String(Number(preferredDate.slice(-2)));
      const clicked = await this.clickCalendarDateByDay(day);
      if (clicked) return preferredDate;
    }
    await this.logCalendarDateSnapshot("未找到匹配的首选日期");
    return undefined;
  }

  private async navigateCalendarToPreferredDate(preferredDate: string): Promise<void> {
    const target = parseDateParts(preferredDate);
    if (!target) return;

    for (let step = 0; step < 12; step += 1) {
      let moved = false;
      let aligned = false;

      for (const scope of this.allScopes()) {
        const result = await scope.locator("body").evaluate((_, targetDate) => {
          type NavigateResult = {
            status: "aligned" | "moved" | "no-calendar" | "no-button" | "unknown-month";
            currentText: string;
            currentYear?: number;
            currentMonth?: number;
            diff?: number;
          };
          const monthMap: Record<string, number> = {
            "一": 1,
            "二": 2,
            "三": 3,
            "四": 4,
            "五": 5,
            "六": 6,
            "七": 7,
            "八": 8,
            "九": 9,
            "十": 10,
            "十一": 11,
            "十二": 12,
            Jan: 1,
            January: 1,
            Feb: 2,
            February: 2,
            Mar: 3,
            March: 3,
            Apr: 4,
            April: 4,
            May: 5,
            Jun: 6,
            June: 6,
            Jul: 7,
            July: 7,
            Aug: 8,
            August: 8,
            Sep: 9,
            September: 9,
            Oct: 10,
            October: 10,
            Nov: 11,
            November: 11,
            Dec: 12,
            December: 12
          };
          const isVisible = (element: Element): boolean => {
            const html = element as HTMLElement;
            const rect = html.getBoundingClientRect();
            const style = window.getComputedStyle(html);
            return style.display !== "none"
              && style.visibility !== "hidden"
              && rect.width > 0
              && rect.height > 0;
          };
          const clickElement = (element: Element): void => {
            (window as typeof window & { __bochkAutomationIgnoreUntil?: number }).__bochkAutomationIgnoreUntil = Date.now() + 1500;
            const html = element as HTMLElement;
            html.scrollIntoView({ block: "center", inline: "center" });
            const rect = html.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const targetElement = document.elementFromPoint(x, y) as HTMLElement | null;
            const clickable = targetElement || html;
            for (const type of ["mouseover", "mousemove", "mousedown", "mouseup", "click"]) {
              clickable.dispatchEvent(new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: x,
                clientY: y
              }));
            }
            clickable.click();
          };
          const parseMonth = (text: string): number | undefined => {
            const numeric = text.match(/(\d{1,2})\s*月/);
            if (numeric) return Number(numeric[1]);
            const chinese = text.match(/(十一|十二|十|一|二|三|四|五|六|七|八|九)月/);
            if (chinese) return monthMap[chinese[1]];
            const english = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i);
            if (english) {
              const raw = english[1];
              const key = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
              return monthMap[key] ?? monthMap[key.slice(0, 3)];
            }
            return undefined;
          };
          const parseYear = (text: string): number | undefined => {
            const match = text.match(/(20\d{2})\s*年|年\s*(20\d{2})|\b(20\d{2})\b/);
            return match ? Number(match[1] || match[2] || match[3]) : undefined;
          };
          const calendar = Array.from(document.querySelectorAll<HTMLElement>(".ui-datepicker, [id*='datepicker' i], [class*='datepicker' i]"))
            .find((element) => isVisible(element) && Boolean(element.querySelector(".ui-datepicker-calendar, table, td"))) ?? undefined;
          if (!calendar) {
            return { status: "no-calendar", currentText: "" } satisfies NavigateResult;
          }
          const titleElement = calendar.querySelector<HTMLElement>(".ui-datepicker-title")
            || calendar.querySelector<HTMLElement>(".ui-datepicker-header")
            || calendar;
          const currentText = (titleElement.textContent || calendar.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
          const currentYear = parseYear(currentText);
          const currentMonth = parseMonth(currentText);
          if (!currentYear || !currentMonth) {
            return { status: "unknown-month", currentText } satisfies NavigateResult;
          }
          const diff = (targetDate.year - currentYear) * 12 + (targetDate.month - currentMonth);
          if (diff === 0) {
            return { status: "aligned", currentText, currentYear, currentMonth, diff } satisfies NavigateResult;
          }
          const selector = diff > 0
            ? ".ui-datepicker-next, [data-handler='next'], a[title*='下'], a[title*='Next'], button[title*='下'], button[aria-label*='Next']"
            : ".ui-datepicker-prev, [data-handler='prev'], a[title*='上'], a[title*='Prev'], button[title*='上'], button[aria-label*='Prev']";
          const button = Array.from(calendar.querySelectorAll<HTMLElement>(selector)).find(isVisible)
            || Array.from(document.querySelectorAll<HTMLElement>(selector)).find(isVisible);
          if (!button) {
            return { status: "no-button", currentText, currentYear, currentMonth, diff } satisfies NavigateResult;
          }
          clickElement(button);
          return { status: "moved", currentText, currentYear, currentMonth, diff } satisfies NavigateResult;
        }, target).catch(() => undefined);

        if (!result) continue;
        if (result.status === "aligned") {
          await this.logger.result(`日历月份已对齐目标日期：${preferredDate}，当前=${result.currentText}`);
          aligned = true;
          break;
        }
        if (result.status === "moved") {
          await this.logger.result(`日历翻页寻找目标日期：${preferredDate}，当前=${result.currentText}，diff=${result.diff}`);
          moved = true;
          break;
        }
      }

      if (aligned) return;
      if (!moved) {
        await this.logger.result(`日历翻页停止：无法继续切换到目标日期月份 ${preferredDate}`);
        return;
      }
      await this.requirePage().waitForTimeout(450);
    }

    await this.logger.result(`日历翻页停止：12 次内未能切换到目标日期月份 ${preferredDate}`);
  }

  private async clickCalendarDateByDay(day: string): Promise<string | undefined> {
    for (const scope of this.allScopes()) {
      const locator = scope.locator([
        ".ui-datepicker-calendar td:not(.ui-datepicker-unselectable) a.ui-state-default",
        ".ui-datepicker-calendar td:not(.ui-datepicker-unselectable) a",
        ".ui-datepicker-calendar a.ui-state-default",
        "[id*='datepicker' i] a.ui-state-default",
        "[class*='datepicker' i] a.ui-state-default"
      ].join(",")).filter({ hasText: new RegExp(`^\\s*${day}\\s*$`) }).first();

      if (!await locator.isVisible({ timeout: 500 }).catch(() => false)) continue;
      await locator.scrollIntoViewIfNeeded().catch(() => undefined);
      await this.markAutomationAction();
      await locator.click({ force: true }).catch(async () => {
        await locator.evaluate((node) => {
          const element = node as HTMLElement;
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          for (const type of ["mouseover", "mousemove", "mousedown", "mouseup", "click"]) {
            element.dispatchEvent(new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: x,
              clientY: y
            }));
          }
          element.click();
        }).catch(() => undefined);
      });
      await this.requirePage().waitForTimeout(650);
      await this.logger.result(`选择日期成功：jQuery UI 日历 ${day}`);
      return day;
    }

    for (const scope of this.allScopes()) {
      const clicked = await scope.locator("body").evaluate((_, targetDay) => {
        const parseRgbValue = (value: string): { r: number; g: number; b: number } | undefined => {
          const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
          if (!match) return undefined;
          return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
        };
        const isVisible = (element: HTMLElement): boolean => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0;
        };
        const isAvailableDate = (element: HTMLElement): boolean => {
          const text = element.textContent?.trim() || "";
          if (text !== targetDay || !isVisible(element)) return false;
          const className = element.className.toString().toLowerCase();
          const parentClassName = element.parentElement?.className.toString().toLowerCase() || "";
          const style = window.getComputedStyle(element);
          const color = parseRgbValue(style.color);
          const isDisabled = element.getAttribute("aria-disabled") === "true"
            || element.hasAttribute("disabled")
            || /disabled|unavailable|inactive|off|grey|gray|full|non|not|unselectable/.test(`${className} ${parentClassName}`)
            || style.pointerEvents === "none"
            || Number(style.opacity || "1") < 0.55;
          if (isDisabled) return false;
          const isClickable = Boolean(
            element.closest("a,button,[role='button']")
            || element.getAttribute("onclick")
            || element.querySelector("a,button,[role='button']")
          );
          const isJQueryUiDate = Boolean(
            element.closest(".ui-datepicker-calendar")
            && (
              element.matches("a.ui-state-default")
              || element.querySelector("a.ui-state-default")
              || element.closest("td")?.querySelector("a.ui-state-default")
            )
          );
          const isDarkBlue = color ? color.b >= color.r + 25 && color.b >= color.g + 10 && color.r < 100 : false;
          const isNotGrey = color ? Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) > 35 : true;
          return isJQueryUiDate || isClickable || (isDarkBlue && isNotGrey);
        };
        const dispatchClick = (element: HTMLElement): void => {
          (window as typeof window & { __bochkAutomationIgnoreUntil?: number }).__bochkAutomationIgnoreUntil = Date.now() + 1500;
          element.scrollIntoView({ block: "center", inline: "center" });
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
          element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
          element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
          element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
          element.click();
        };

        const dateLink = Array.from(document.querySelectorAll<HTMLElement>(".ui-datepicker-calendar td:not(.ui-datepicker-unselectable) a.ui-state-default"))
          .find((element) => isVisible(element) && element.textContent?.trim() === targetDay);
        if (dateLink) {
          dispatchClick(dateLink);
          return true;
        }

        const candidates = Array.from(document.querySelectorAll("td,a,button,span,div,[role='button']")) as HTMLElement[];
        const target = candidates.find((element) => isAvailableDate(element));
        if (!target) return false;
        const clickable = target.matches("a,button,[role='button']")
          ? target
          : target.querySelector("a,button,[role='button']") as HTMLElement | null
            || target.closest("a,button,[role='button']") as HTMLElement | null;
        dispatchClick(clickable || target);
        return true;
      }, day).catch(() => false);

      if (clicked) {
        await this.requirePage().waitForTimeout(500);
        await this.logger.result(`选择日期成功：日历 ${day}`);
        return day;
      }
    }
    await this.logCalendarDateSnapshot(`选择日期失败：日历中没有可点击日期 ${day}`);
    return undefined;
  }

  private async logCalendarDateSnapshot(reason: string): Promise<void> {
    const snapshots: Array<{ scope: string; dates: string[]; html: string }> = [];
    for (const [index, scope] of this.allScopes().entries()) {
      const snapshot = await scope.locator("body").evaluate(() => {
        const isVisible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const rect = html.getBoundingClientRect();
          const style = window.getComputedStyle(html);
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0;
        };
        const calendar = document.querySelector(".ui-datepicker-calendar")
          || document.querySelector("[id*='datepicker' i]")
          || document.querySelector("[class*='datepicker' i]");
        const dates = Array.from(document.querySelectorAll(".ui-datepicker-calendar td, .ui-datepicker-calendar a, [id*='datepicker' i] td, [id*='datepicker' i] a"))
          .filter((node) => isVisible(node))
          .map((node) => {
            const element = node as HTMLElement;
            const text = element.textContent?.trim() || "";
            if (!/^\d{1,2}$/.test(text)) return "";
            const cell = element.closest("td");
            const disabled = Boolean(cell?.className.match(/unselectable|disabled|inactive|off/i))
              || Boolean(element.className.match(/disabled|inactive|off/i));
            const link = element.matches("a") || Boolean(element.querySelector("a"));
            return `${text}${disabled ? ":disabled" : ""}${link ? ":link" : ""}`;
          })
          .filter(Boolean)
          .slice(0, 80);
        return {
          dates,
          html: calendar ? (calendar as HTMLElement).outerHTML.slice(0, 1200) : ""
        };
      }).catch(() => undefined);
      if (snapshot && (snapshot.dates.length > 0 || snapshot.html)) {
        snapshots.push({
          scope: index === 0 ? "main" : `iframe-${index}`,
          dates: snapshot.dates,
          html: snapshot.html
        });
      }
    }

    await this.logger.result(`${reason}；日历快照：${JSON.stringify(snapshots).slice(0, 3000)}`);
  }

  private async selectFirstMatchingDate(selector: string, knownLocator?: Locator): Promise<string | undefined> {
    const preferredDates = this.request.appointment.preferredDates ?? [];
    const selectedDate = await this.currentSelectedAppointmentDate();
    const selectedPreferredDate = preferredDates.find((date) => selectedDate && dateOptionMatches(selectedDate, selectedDate, date));
    if (selectedDate && (preferredDates.length === 0 || selectedPreferredDate)) {
      const date = selectedPreferredDate ?? selectedDate;
      await this.logger.result(`预约日期已选中，跳过日历：${date}`);
      return date;
    }

    if (preferredDates.length === 0) {
      return await this.selectFirstAvailableOption(selector) ?? await this.clickFirstAvailableCalendarDate();
    }

    const locator = knownLocator && await this.isDateSelectLocator(knownLocator)
      ? knownLocator
      : await this.firstVisibleDateSelect(selector, preferredDates.join(" "));
    if (locator) {
      const selectOptions = await locator.locator("option").evaluateAll((nodes) =>
        nodes.map((node) => ({
          label: node.textContent?.trim() ?? "",
          value: (node as HTMLOptionElement).value,
          disabled: (node as HTMLOptionElement).disabled
        }))
      );

      const match = selectOptions.find((option) =>
        option.value
        && !option.disabled
        && !/請選|请选择|select|已滿|已满|full/i.test(option.label)
        && preferredDates.some((date) => dateOptionMatches(option.label, option.value, date))
      );
      if (match) {
        await this.markAutomationAction();
        await locator.selectOption(match.value);
        await this.logger.result(`选择日期成功：${match.label}`);
        return match.label;
      }
    }

    const calendarOpened = await this.openCalendarControls();
    const calendarDate = calendarOpened ? await this.clickPreferredCalendarDate(preferredDates) : undefined;
    if (calendarDate) return calendarDate;

    await this.logger.result(`选择日期失败：找不到匹配日期 ${preferredDates.join(", ")}`);
    return undefined;
  }

  private async currentSelectedAppointmentDate(): Promise<string | undefined> {
    const selector = [
      "#eAAOForm_appDate_field",
      "input[name='bean.appDate']",
      "input.hasDatepicker",
      "input[id*='appDate' i]",
      "input[name*='appDate' i]"
    ].join(",");

    for (const scope of this.allScopes()) {
      const locator = scope.locator(selector).first();
      if (await locator.count().catch(() => 0) === 0) continue;
      const value = await locator.evaluate((node) => {
        const input = node as HTMLInputElement;
        return input.value || input.getAttribute("value") || "";
      }).catch(() => "");
      const text = value.trim();
      if (looksLikeAppointmentDateValue(text)) return text;
    }
    return undefined;
  }

  private async openCalendarControls(): Promise<boolean> {
    if (await this.isCalendarPopupOpen()) {
      return true;
    }

    if (await this.clickKnownBochkDateInput()) {
      await this.requirePage().waitForTimeout(700);
      if (await this.isCalendarPopupOpen()) {
        await this.logger.result("已点击 BOCHK 预约日期输入框并打开日历控件");
        return true;
      }
      await this.logger.result("已点击 BOCHK 预约日期输入框，但未检测到日历弹层，继续尝试其他路径");
    }

    for (const scope of this.allScopes()) {
      const controls = scope.locator([
        ".ui-datepicker-trigger",
        ".hasDatepicker + img",
        "[onclick*='date' i]",
        "[onclick*='calendar' i]",
        "[onclick*='日曆' i]",
        "[onclick*='日历' i]",
        "img[src*='calendar' i]",
        "img[src*='cal' i]",
        "img[src*='date' i]",
        "img[id*='calendar' i]",
        "img[class*='calendar' i]",
        "img[id*='date' i]",
        "img[class*='date' i]",
        "button[id*='calendar' i]",
        "button[class*='calendar' i]",
        "button[id*='date' i]",
        "button[class*='date' i]",
        "a[id*='calendar' i]",
        "a[class*='calendar' i]",
        "a[id*='date' i]",
        "a[class*='date' i]",
        "[role='button'][aria-label*='calendar' i]",
        "[role='button'][title*='calendar' i]",
        "[role='button'][title*='日曆' i]",
        "[role='button'][title*='日历' i]",
        "input[id*='date' i] + img",
        "input[name*='date' i] + img"
      ].join(","));
      const count = Math.min(await controls.count().catch(() => 0), 8);
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        if (!await control.isVisible({ timeout: 500 }).catch(() => false)) continue;
        await control.scrollIntoViewIfNeeded().catch(() => undefined);
        await this.markAutomationAction();
        await control.click({ force: true }).catch(async () => {
          await control.evaluate((node) => (node as HTMLElement).click()).catch(() => undefined);
        });
        await this.requirePage().waitForTimeout(700);
        if (await this.isCalendarPopupOpen()) {
          await this.logger.result("已点击日历控件，准备读取可预约日期");
          return true;
        }
      }
    }

    if (await this.clickBochkDatePickerByLabel()) {
      await this.requirePage().waitForTimeout(700);
      if (await this.isCalendarPopupOpen()) {
        await this.logger.result("已通过预约日期标签精准打开日历控件");
        return true;
      }
      await this.logger.result("已点击预约日期输入框右侧，但未检测到日历弹层，继续尝试其他路径");
    }

    if (await this.clickCalendarControlByDateContext()) {
      await this.requirePage().waitForTimeout(700);
      if (await this.isCalendarPopupOpen()) {
        await this.logger.result("已根据预约日期行点击日历控件，准备读取可预约日期");
        return true;
      }
      await this.logger.result("已点击预约日期区域，但未检测到日历弹层，改用输入框右侧重试");
    }

    if (await this.clickDateInputRightEdge()) {
      await this.requirePage().waitForTimeout(700);
      if (await this.isCalendarPopupOpen()) {
        await this.logger.result("已点击预约日期输入框右侧日历图标，准备读取可预约日期");
        return true;
      }
    }

    await this.logger.result("未找到可点击的日历控件");
    return false;
  }

  private async clickKnownBochkDateInput(): Promise<boolean> {
    const selectors = [
      "#eAAOForm_appDate_field",
      "input[name='bean.appDate']",
      "input.datePicker[title*='預約日期']",
      "input.datePicker[title*='预约日期']",
      "input.datePicker",
      "input[id*='appDate' i]",
      "input[name*='appDate' i]"
    ].join(",");

    for (const scope of this.allScopes()) {
      const candidates = scope.locator(selectors);
      const count = Math.min(await candidates.count().catch(() => 0), 6);
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        const meta = await candidate.evaluate((node) => {
          const input = node as HTMLInputElement;
          const rect = input.getBoundingClientRect();
          const style = window.getComputedStyle(input);
          return {
            visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
            id: input.id || "",
            name: input.name || "",
            title: input.title || "",
            className: input.className || "",
            readonly: input.readOnly
          };
        }).catch(() => undefined);
        if (!meta?.visible) continue;

        await candidate.scrollIntoViewIfNeeded().catch(() => undefined);
        await this.centerLocatorInViewport(candidate);
        let box = await candidate.boundingBox().catch(() => null);
        if (box) {
          const x = box.x + Math.max(12, box.width - 14);
          const y = box.y + box.height / 2;
          await this.markAutomationAction();
          await this.requirePage().mouse.move(x, y).catch(() => undefined);
          await this.requirePage().mouse.down().catch(() => undefined);
          await this.requirePage().waitForTimeout(60).catch(() => undefined);
          await this.requirePage().mouse.up().catch(() => undefined);
          await this.requirePage().mouse.click(x, y).catch(() => undefined);
        }

        await this.markAutomationAction();
        await candidate.evaluate((node) => {
          (window as typeof window & { __bochkAutomationIgnoreUntil?: number }).__bochkAutomationIgnoreUntil = Date.now() + 1500;
          const input = node as HTMLInputElement;
          input.focus();
          const rect = input.getBoundingClientRect();
          const x = rect.right - Math.min(14, Math.max(8, rect.width * 0.08));
          const y = rect.top + rect.height / 2;
          const target = document.elementFromPoint(x, y) as HTMLElement | null;
          const clickable = target || input;
          for (const type of ["mouseover", "mousemove", "mousedown", "mouseup", "click"]) {
            clickable.dispatchEvent(new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: x,
              clientY: y
            }));
          }
          clickable.click();
          const jquery = (window as unknown as { jQuery?: (element: Element) => { datepicker?: (command: string) => void } }).jQuery;
          try {
            jquery?.(input).datepicker?.("show");
          } catch {
            // Ignore datepicker API mismatches; the physical click above is the primary path.
          }
        }).catch(() => undefined);

        box = await candidate.boundingBox().catch(() => null);
        await this.logger.result(`点击 BOCHK 预约日期字段：id=${meta.id || "-"} name=${meta.name || "-"} title=${meta.title || "-"} readonly=${meta.readonly ? "yes" : "no"} point=${box ? `${Math.round(box.x + Math.max(12, box.width - 14))},${Math.round(box.y + box.height / 2)}` : "unknown"}`);
        return true;
      }
    }

    if (await this.clickDateInputAfterDateFirstRadio()) {
      return true;
    }

    return false;
  }

  private async clickDateInputAfterDateFirstRadio(): Promise<boolean> {
    for (const scope of this.allScopes()) {
      await this.markAutomationAction();
      const result = await scope.locator("body").evaluate(() => {
        (window as typeof window & { __bochkAutomationIgnoreUntil?: number }).__bochkAutomationIgnoreUntil = Date.now() + 1500;
        const isVisible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const rect = html.getBoundingClientRect();
          const style = window.getComputedStyle(html);
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0;
        };
        const radio = document.querySelector<HTMLInputElement>("input[name='bean.precondition'][value='D'], #openMCaccount_precondition_fieldD");
        const allInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"))
          .filter((input) => isVisible(input) && !/radio|checkbox|hidden|submit|button|reset/i.test(input.type || ""));
        const startIndex = radio ? allInputs.findIndex((input) => input.compareDocumentPosition(radio) & Node.DOCUMENT_POSITION_FOLLOWING) : -1;
        const ordered = startIndex >= 0 ? allInputs.slice(startIndex) : allInputs;
        const candidate = ordered.find((input) => {
          const haystack = `${input.id} ${input.name} ${input.className} ${input.title} ${input.closest("tr")?.textContent || ""}`;
          return /預約日期|预约日期|appDate|datePicker|bean\.appDate/i.test(haystack);
        }) || ordered[0];
        if (!candidate) return null;

        candidate.scrollIntoView({ block: "center", inline: "center" });
        candidate.focus();
        const rect = candidate.getBoundingClientRect();
        const x = rect.right - Math.min(14, Math.max(8, rect.width * 0.08));
        const y = rect.top + rect.height / 2;
        const target = document.elementFromPoint(x, y) as HTMLElement | null;
        const clickable = target || candidate;
        for (const type of ["mouseover", "mousemove", "mousedown", "mouseup", "click"]) {
          clickable.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y
          }));
        }
        clickable.click();
        return {
          id: candidate.id || "",
          name: candidate.name || "",
          title: candidate.title || "",
          className: candidate.className || "",
          x: Math.round(x),
          y: Math.round(y)
        };
      }).catch(() => null);

      if (result) {
        await this.logger.result(`按日期优先单选项后的输入框兜底点击日历：id=${result.id || "-"} name=${result.name || "-"} title=${result.title || "-"} class=${result.className || "-"} at ${result.x},${result.y}`);
        return true;
      }
    }

    return false;
  }

  private async isCalendarPopupOpen(): Promise<boolean> {
    for (const scope of this.allScopes()) {
      const isOpen = await scope.locator([
        ".ui-datepicker:visible",
        "[id*='datepicker' i]:visible",
        "[class*='datepicker' i]:visible",
        "[class*='calendar-panel' i]:visible",
        "[class*='calendar-popup' i]:visible"
      ].join(",")).evaluateAll((nodes) =>
        nodes.some((node) => {
          const element = node as HTMLElement;
          const tag = element.tagName.toLowerCase();
          if (["input", "img", "button", "a"].includes(tag)) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden" || rect.width < 120 || rect.height < 100) {
            return false;
          }
          const text = element.textContent || "";
          const numericCells = Array.from(element.querySelectorAll("td,span,a,button,div"))
            .filter((item) => /^\d{1,2}$/.test(item.textContent?.trim() || "")).length;
          return /(一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月|\d{4})/.test(text)
            || numericCells >= 10;
        })
      ).catch(() => false);
      if (isOpen) {
        await this.logger.result("检测到日历弹层已打开");
        return true;
      }

      const bochkCalendarOpen = await scope.locator("body").evaluate(() => {
        const isVisible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const rect = html.getBoundingClientRect();
          const style = window.getComputedStyle(html);
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width >= 180
            && rect.height >= 150;
        };
        const candidates = Array.from(document.querySelectorAll("div,table"));
        return candidates.some((element) => {
          if (!isVisible(element)) return false;
          const rect = (element as HTMLElement).getBoundingClientRect();
          if (rect.width > window.innerWidth * 0.95 || rect.height > window.innerHeight * 0.9) return false;
          const text = (element.textContent || "").replace(/\s+/g, " ");
          const numericCells = Array.from(element.querySelectorAll("td,a,span,button,div"))
            .filter((item) => /^\d{1,2}$/.test(item.textContent?.trim() || "")).length;
          const hasCalendarHeader = /([一二三四五六七八九十]+月|\d{4}年|日\s*一\s*二\s*三\s*四\s*五\s*六)/.test(text);
          return hasCalendarHeader && numericCells >= 10;
        });
      }).catch(() => false);
      if (bochkCalendarOpen) {
        await this.logger.result("检测到 BOCHK 日历面板已打开");
        return true;
      }
    }
    return false;
  }

  private async clickBochkDatePickerByLabel(): Promise<boolean> {
    for (const scope of this.allScopes()) {
      const result = await scope.locator("body").evaluate(() => {
        type ClickResult = {
          method: string;
          tag: string;
          id: string;
          name: string;
          text: string;
          x: number;
          y: number;
        };

        const isVisible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const rect = html.getBoundingClientRect();
          const style = window.getComputedStyle(html);
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0;
        };
        const isEditableInput = (element: Element): boolean => {
          if (element.tagName.toLowerCase() !== "input") return false;
          const input = element as HTMLInputElement;
          return isVisible(input) && !/radio|checkbox|hidden|submit|button|reset/i.test(input.type || "");
        };
        const isDateIcon = (element: Element): boolean => {
          if (!isVisible(element)) return false;
          const text = [
            element.tagName,
            element.id,
            element.getAttribute("name") || "",
            element.getAttribute("class") || "",
            element.getAttribute("title") || "",
            element.getAttribute("alt") || "",
            element.getAttribute("src") || "",
            element.getAttribute("onclick") || "",
            element.getAttribute("aria-label") || "",
            element.textContent || ""
          ].join(" ");
          return /calendar|cal|date|datepicker|日曆|日历|日期/i.test(text)
            && !/captcha|verify|驗證碼|验证码|示例|可預約日子|不可預約日子/i.test(text);
        };
        const dispatchClick = (x: number, y: number, fallback: Element): void => {
          (window as typeof window & { __bochkAutomationIgnoreUntil?: number }).__bochkAutomationIgnoreUntil = Date.now() + 1500;
          const target = document.elementFromPoint(x, y) as HTMLElement | null;
          const clickable = target || fallback as HTMLElement;
          for (const type of ["mouseover", "mousemove", "mousedown", "mouseup", "click"]) {
            clickable.dispatchEvent(new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: x,
              clientY: y
            }));
          }
          clickable.click();
        };
        const clickAtElementCenter = (element: Element, method: string): ClickResult => {
          const html = element as HTMLElement;
          html.scrollIntoView({ block: "center", inline: "center" });
          const rect = html.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          dispatchClick(x, y, element);
          return {
            method,
            tag: html.tagName.toLowerCase(),
            id: html.id,
            name: html.getAttribute("name") || "",
            text: (html.textContent || html.getAttribute("alt") || html.getAttribute("title") || "").trim().slice(0, 60),
            x: Math.round(x),
            y: Math.round(y)
          };
        };
        const clickInputRightEdge = (input: Element, method: string): ClickResult => {
          const html = input as HTMLElement;
          html.scrollIntoView({ block: "center", inline: "center" });
          const rect = html.getBoundingClientRect();
          const x = rect.right - Math.min(18, Math.max(8, rect.width * 0.12));
          const y = rect.top + rect.height / 2;
          dispatchClick(x, y, input);
          return {
            method,
            tag: html.tagName.toLowerCase(),
            id: html.id,
            name: html.getAttribute("name") || "",
            text: (html.getAttribute("placeholder") || html.getAttribute("value") || "").trim().slice(0, 60),
            x: Math.round(x),
            y: Math.round(y)
          };
        };
        const findLabels = (): HTMLElement[] => Array.from(document.querySelectorAll("label,td,th,span,div,p"))
          .filter((element) => {
            if (!isVisible(element)) return false;
            const text = (element.textContent || "").replace(/\s+/g, " ").trim();
            return /^(預約日期|预约日期|Appointment Date)$/i.test(text);
          }) as HTMLElement[];

        for (const label of findLabels()) {
          const containers: Element[] = [];
          let current: Element | null = label;
          for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
            containers.push(current);
          }

          for (const container of containers) {
            const icons = Array.from(container.querySelectorAll("img,button,a,span[onclick],input[type='image']"))
              .filter(isDateIcon);
            const icon = icons
              .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
            if (icon) {
              return clickAtElementCenter(icon, "label-container-icon");
            }

            const input = Array.from(container.querySelectorAll("input"))
              .filter(isEditableInput)
              .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
            if (input) {
              return clickInputRightEdge(input, "label-container-input-right-edge");
            }
          }

          const labelRect = label.getBoundingClientRect();
          const candidates = Array.from(document.querySelectorAll("input,img,button,a,span[onclick],input[type='image']"))
            .filter((element) => {
              if (!isVisible(element)) return false;
              const rect = (element as HTMLElement).getBoundingClientRect();
              const centerY = rect.top + rect.height / 2;
              const labelCenterY = labelRect.top + labelRect.height / 2;
              const isNearDateRow = Math.abs(centerY - labelCenterY) <= 120
                && rect.left >= labelRect.right - 20
                && rect.left <= labelRect.right + 760
                && rect.top >= labelRect.top - 90
                && rect.top <= labelRect.bottom + 170;
              if (!isNearDateRow) return false;
              return isDateIcon(element) || isEditableInput(element);
            });
          const icon = candidates
            .filter(isDateIcon)
            .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
          if (icon) {
            return clickAtElementCenter(icon, "label-geometry-icon");
          }

          const input = candidates
            .filter(isEditableInput)
            .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
          if (input) {
            return clickInputRightEdge(input, "label-geometry-input-right-edge");
          }
        }

        const dateLikeInputs = Array.from(document.querySelectorAll("input"))
          .filter((element) => {
            if (!isEditableInput(element)) return false;
            const input = element as HTMLInputElement;
            const text = `${input.id} ${input.name} ${input.className} ${input.placeholder}`.toLowerCase();
            return /date|appointment|booking|book|appdate|bkdate/.test(text);
          }) as HTMLInputElement[];
        const dateLikeInput = dateLikeInputs
          .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
        if (dateLikeInput) {
          return clickInputRightEdge(dateLikeInput, "date-like-input-right-edge");
        }

        return null;
      }).catch(() => null);

      if (result) {
        await this.logger.result(`点击预约日期控件：${result.method} ${result.tag}#${result.id || "-"} name=${result.name || "-"} at ${result.x},${result.y}`);
        return true;
      }
    }

    return false;
  }

  private async clickCalendarControlByDateContext(): Promise<boolean> {
    for (const scope of this.allScopes()) {
      const clicked = await scope.locator("body").evaluate(() => {
        const isVisible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const rect = html.getBoundingClientRect();
          const style = window.getComputedStyle(html);
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0;
        };
        const clickElement = (element: Element): void => {
          (window as typeof window & { __bochkAutomationIgnoreUntil?: number }).__bochkAutomationIgnoreUntil = Date.now() + 1500;
          const html = element as HTMLElement;
          html.scrollIntoView({ block: "center", inline: "center" });
          const rect = html.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const target = document.elementFromPoint(x, y) as HTMLElement | null;
          const clickable = target && target !== html ? target : html;
          clickable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
          clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
          clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
          clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
          clickable.click();
        };
        const clickDateInputRightEdge = (input: Element): void => {
          (window as typeof window & { __bochkAutomationIgnoreUntil?: number }).__bochkAutomationIgnoreUntil = Date.now() + 1500;
          const html = input as HTMLElement;
          html.scrollIntoView({ block: "center", inline: "center" });
          const rect = html.getBoundingClientRect();
          const x = rect.left + Math.max(12, rect.width - 18);
          const y = rect.top + rect.height / 2;
          const target = document.elementFromPoint(x, y) as HTMLElement | null;
          const clickable = target && target !== html ? target : html;
          clickable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
          clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
          clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
          clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
        };
        const textMatchesDateLabel = (value: string): boolean =>
          /預約日期|预约日期|預約日|预约日|Appointment Date/i.test(value);
        const textMatchesBranchFirstChoice = (value: string): boolean =>
          /先選定分行|先选定分行/i.test(value);
        const attributeText = (element: Element): string =>
          [
            element.tagName,
            element.id,
            element.getAttribute("name") || "",
            element.getAttribute("class") || "",
            element.getAttribute("title") || "",
            element.getAttribute("alt") || "",
            element.getAttribute("src") || "",
            element.getAttribute("onclick") || "",
            element.getAttribute("aria-label") || "",
            element.textContent || ""
          ].join(" ");
        const isRealDateControl = (element: Element): boolean => {
          const parentText = element.parentElement?.textContent || "";
          const smallParentText = parentText.length <= 80 ? parentText : "";
          const text = [
            element.textContent || "",
            smallParentText,
            element.getAttribute("alt") || "",
            element.getAttribute("title") || "",
            element.getAttribute("src") || "",
            element.getAttribute("class") || "",
            element.getAttribute("id") || ""
          ].join(" ");
          return !/示例|可預約日子|可预约日子|不可預約日子|不可预约日子|驗證碼|验证码|captcha/i.test(text);
        };
        const clickDateControlByGeometry = (): boolean => {
          const labels = Array.from(document.querySelectorAll("td,th,label,span,div"))
            .filter((element) => {
              if (!isVisible(element)) return false;
              const text = element.textContent?.replace(/\s+/g, " ").trim() || "";
              return /^(預約日期|预约日期|Appointment Date)$/i.test(text);
            }) as HTMLElement[];

          for (const label of labels) {
            const labelRect = label.getBoundingClientRect();
            const controls = Array.from(document.querySelectorAll("input,img,button,a,span[onclick]"))
              .filter((element) => {
                if (!isVisible(element) || !isRealDateControl(element)) return false;
                const html = element as HTMLElement;
                const tag = html.tagName.toLowerCase();
                const input = html as HTMLInputElement;
                if (tag === "input" && /radio|checkbox|hidden|submit|button/i.test(input.type || "")) return false;
                const rect = html.getBoundingClientRect();
                const sameRow = Math.abs((rect.top + rect.height / 2) - (labelRect.top + labelRect.height / 2)) <= 34;
                const rightOfLabel = rect.left >= labelRect.right + 80;
                const notTooFar = rect.left <= labelRect.right + 520;
                return sameRow && rightOfLabel && notTooFar;
              }) as HTMLElement[];
            const icon = controls
              .filter((element) => element.tagName.toLowerCase() === "img" || /calendar|datepicker|cal|date/i.test(attributeText(element)))
              .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
              .pop();
            if (icon) {
              clickElement(icon);
              return true;
            }

            const input = controls.find((element) => element.tagName.toLowerCase() === "input");
            if (input) {
              clickDateInputRightEdge(input);
              return true;
            }
          }

          return false;
        };

        if (clickDateControlByGeometry()) {
          return true;
        }

        const containers = Array.from(document.querySelectorAll("tr,li,fieldset,table,div,p"))
          .filter((element) => {
            if (!isVisible(element)) return false;
            const text = element.textContent || "";
            return textMatchesDateLabel(text)
              && !textMatchesBranchFirstChoice(text)
              && element.querySelector("input:not([type='hidden']):not([type='radio']):not([type='checkbox']),img,button,a,span[onclick]");
          })
          .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length)
          .slice(0, 8);

        for (const container of containers) {
          const clickables = Array.from(container.querySelectorAll("img,button,a,span,input"))
            .filter((element) => isVisible(element) && isRealDateControl(element));
          const preferred = clickables.find((element) =>
            /calendar|datepicker|date|cal|日曆|日历|日期/i.test(attributeText(element))
            && !/captcha|驗證碼|验证码|verify/i.test(attributeText(element))
          )
            ?? clickables.find((element) => element.tagName.toLowerCase() === "img"
              && !/captcha|驗證碼|验证码|verify/i.test(attributeText(element)))
            ?? clickables.find((element) => {
              const tag = element.tagName.toLowerCase();
              const input = element as HTMLInputElement;
              return tag === "input" && !/radio|checkbox|hidden|submit|button/i.test(input.type || "");
            });
          if (!preferred) continue;
          if (preferred.tagName.toLowerCase() === "input") {
            clickDateInputRightEdge(preferred);
          } else {
            clickElement(preferred);
          }
          return true;
        }

        const labels = Array.from(document.querySelectorAll("label,td,th,span,div"))
          .filter((element) => {
            if (!isVisible(element)) return false;
            const text = element.textContent || "";
            return textMatchesDateLabel(text) && !textMatchesBranchFirstChoice(text);
          })
          .slice(0, 12);
        for (const label of labels) {
          let parent: Element | null = label;
          for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
            const input = parent.querySelector("input:not([type='hidden']):not([type='radio']):not([type='checkbox']):not([type='submit']):not([type='button'])");
            if (input && isVisible(input)) {
              clickDateInputRightEdge(input);
              return true;
            }
            const icon = parent.querySelector("img,button,a,span[onclick]");
            if (icon && isVisible(icon)) {
              clickElement(icon);
              return true;
            }
          }
        }

        return false;
      }).catch(() => false);
      if (clicked) {
        return true;
      }
    }

    for (const scope of this.allScopes()) {
      const dateInput = await this.findInputNearText(scope, /預約日期|预约日期|Appointment Date/i);
      if (!dateInput) continue;
      await dateInput.scrollIntoViewIfNeeded().catch(() => undefined);
      const box = await dateInput.boundingBox().catch(() => null);
      if (box) {
        await this.markAutomationAction();
        await this.requirePage().mouse.click(box.x + Math.max(8, box.width - 12), box.y + box.height / 2);
        return true;
      }
      await this.markAutomationAction();
      await dateInput.click({ force: true }).catch(() => undefined);
      return true;
    }

    return false;
  }

  private async clickDateInputRightEdge(): Promise<boolean> {
    for (const scope of this.allScopes()) {
      const dateInput = await this.findInputNearText(scope, /預約日期|预约日期|Appointment Date/i)
        ?? await this.findDateInputByGeometry(scope);
      if (!dateInput) continue;
      await dateInput.scrollIntoViewIfNeeded().catch(() => undefined);
      const box = await dateInput.boundingBox().catch(() => null);
      if (box) {
        const x = box.x + Math.max(10, box.width - 11);
        const y = box.y + box.height / 2;
        await this.markAutomationAction();
        await this.requirePage().mouse.move(x, y);
        await this.requirePage().mouse.down();
        await this.requirePage().waitForTimeout(40);
        await this.requirePage().mouse.up();
        await this.logger.result(`已精准点击预约日期输入框右侧图标坐标：${Math.round(x)},${Math.round(y)}`);
        return true;
      }
      await this.markAutomationAction();
      await dateInput.click({ force: true }).catch(() => undefined);
      return true;
    }

    return false;
  }

  private async findDateInputByGeometry(scope: Page | Frame): Promise<Locator | undefined> {
    const inputs = scope.locator("input:visible:not([type='radio']):not([type='checkbox']):not([type='hidden']):not([type='submit']):not([type='button'])");
    const index = await scope.locator("body").evaluate(() => {
      const isVisible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const rect = html.getBoundingClientRect();
        const style = window.getComputedStyle(html);
        return style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0;
      };
      const dateLabels = Array.from(document.querySelectorAll("td,th,label,span,div"))
        .filter((element) => {
          if (!isVisible(element)) return false;
          const text = element.textContent?.replace(/\s+/g, " ").trim() || "";
          return /^(預約日期|预约日期|Appointment Date)$/i.test(text);
        }) as HTMLElement[];
      const visibleInputs = Array.from(document.querySelectorAll("input"))
        .filter((element) => {
          const input = element as HTMLInputElement;
          return isVisible(input) && !/radio|checkbox|hidden|submit|button/i.test(input.type || "");
        }) as HTMLInputElement[];

      for (const label of dateLabels) {
        const labelRect = label.getBoundingClientRect();
        const match = visibleInputs.find((input) => {
          const rect = input.getBoundingClientRect();
          const centerY = rect.top + rect.height / 2;
          const labelCenterY = labelRect.top + labelRect.height / 2;
          return Math.abs(centerY - labelCenterY) <= 42
            && rect.left >= labelRect.right + 70
            && rect.left <= labelRect.right + 560
            && rect.width >= 80
            && rect.width <= 360;
        });
        if (match) {
          return visibleInputs.indexOf(match);
        }
      }
      return -1;
    }).catch(() => -1);

    if (index < 0) return undefined;
    await this.logger.result(`已通过几何定位找到预约日期输入框 index=${index}`);
    return inputs.nth(index);
  }

  private async findInputNearText(scope: Page | Frame, pattern: RegExp): Promise<Locator | undefined> {
    const inputs = scope.locator("input:visible:not([type='radio']):not([type='checkbox']):not([type='hidden']):not([type='submit']):not([type='button'])");
    const count = await inputs.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const input = inputs.nth(index);
      const context = await input.evaluate((node) => {
        const element = node as HTMLInputElement;
        if (/radio|checkbox|hidden|submit|button/i.test(element.type || "")) return "";
        const idLabel = element.id ? document.querySelector(`label[for="${element.id}"]`)?.textContent || "" : "";
        const parent = element.parentElement?.textContent || "";
        const row = element.closest("tr")?.textContent || "";
        const fieldset = element.closest("fieldset")?.textContent || "";
        const previous = element.previousElementSibling?.textContent || "";
        return `${element.name} ${element.id} ${element.className} ${element.placeholder} ${idLabel} ${parent} ${row} ${fieldset} ${previous}`;
      }).catch(() => "");
      if (pattern.test(context)) {
        return input;
      }
    }
    return undefined;
  }

  private async selectFirstMatchingTime(selector: string, knownLocator?: Locator): Promise<string | undefined> {
    const locator = knownLocator ?? await this.firstVisibleLocator(selector) ?? await this.findSelectByText((this.request.appointment.preferredTimes ?? []).join(" "));
    if (!locator) {
      await this.logger.selector("选择时间失败，找不到 selector", selector);
      return undefined;
    }

    const options = await locator.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: node.textContent?.trim() ?? "",
        value: (node as HTMLOptionElement).value,
        disabled: (node as HTMLOptionElement).disabled
      }))
    );

    const option = options.find((item) => {
      const time = item.label.match(/\b([01]\d|2[0-3]):[0-5]\d\b/)?.[0];
      return item.value && !item.disabled && time && this.isPreferredTime(time);
    });
    if (!option) {
      await this.logger.result(`选择时间失败：找不到匹配时间 ${(this.request.appointment.preferredTimes ?? []).join(", ")}`);
      return undefined;
    }

    await this.markAutomationAction();
    await locator.selectOption(option.value);
    await this.logger.result(`选择时间成功：${option.label}`);
    return option.label;
  }

  private async matchingTimeOptionsFromLocator(locator?: Locator): Promise<SelectOptionSnapshot[]> {
    if (!locator) {
      await this.logger.selector("选择时间失败，找不到 selector", bochkSelectors.time);
      return [];
    }

    const options = await this.readSelectOptions(locator);
    const matchingOptions = options.filter((item) => {
      const time = item.label.match(/\b([01]\d|2[0-3]):[0-5]\d\b/)?.[0];
      return item.value
        && !item.disabled
        && !/請選|请选择|select|已滿|已满|full/i.test(item.label)
        && time
        && this.isPreferredTime(time);
    });
    await this.logger.result(
      `符合要求的可选时间段：${matchingOptions.map((option) => option.label || option.value).join(", ") || "无"}`
    );
    return matchingOptions;
  }

  private async selectTimeOptionFromLocator(locator: Locator | undefined, option: SelectOptionSnapshot): Promise<string | undefined> {
    if (!locator || !option.value) return undefined;
    await this.markAutomationAction();
    await locator.selectOption(option.value).catch(() => undefined);
    await this.requirePage().waitForTimeout(250);
    const selectedValue = await locator.evaluate((node) => (node as HTMLSelectElement).value).catch(() => "");
    if (selectedValue !== option.value) {
      await this.logger.result(`选择时间失败：${option.label || option.value}`);
      return undefined;
    }
    const label = option.label || option.value;
    await this.logger.result(`选择时间成功：${label}`);
    return label;
  }

  private isPreferredTime(time: string): boolean {
    const preferredTimes = this.request.appointment.preferredTimes ?? [];
    if (preferredTimes.length > 0) {
      return preferredTimes.includes(time);
    }
    return this.request.appointment.timeWindows.some((window) => time >= window.start && time <= window.end);
  }

  private async findSelectByText(hint: string): Promise<Locator | undefined> {
    const hintText = hint.toLowerCase();
    for (const scope of this.allScopes()) {
      const selects = scope.locator("select:visible");
      const count = await selects.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const select = selects.nth(index);
        const meta = await select.evaluate((node) => {
          const element = node as HTMLSelectElement;
          const label = element.id ? document.querySelector(`label[for="${element.id}"]`)?.textContent?.trim() || "" : "";
          const options = Array.from(element.options).map((option) => option.textContent?.trim() || "").join(" ");
          return `${element.name} ${element.id} ${label} ${options}`.toLowerCase();
        }).catch(() => "");
        if (!hintText || hintText.split(/\s+/).some((part) => part && meta.includes(part)) || /地區|地区|分行|日期|時間|时间|country|area|branch|date|time|account|idtype/i.test(meta)) {
          return select;
        }
      }
    }
    return undefined;
  }

  private async selectedLabel(selector: string): Promise<string | undefined> {
    const locator = await this.firstVisibleLocator(selector);
    if (!locator) {
      return undefined;
    }
    return this.selectedLabelFromLocator(locator);
  }

  private async selectedLabelFromLocator(locator: Locator | undefined): Promise<string | undefined> {
    if (!locator) {
      return undefined;
    }
    return locator.evaluate((select) => {
      const element = select as HTMLSelectElement;
      return element.selectedOptions[0]?.textContent?.trim();
    });
  }

  private async selectSalutationRadio(label: CustomerInfo["salutation"]): Promise<boolean> {
    const valueMap: Record<CustomerInfo["salutation"], string> = {
      "先生": "1",
      "小姐": "2",
      "太太": "3",
      "女士": "4"
    };
    const value = valueMap[label];
    for (const scope of this.allScopes()) {
      const radio = scope.locator([
        `#eAAOForm_title_field${value}`,
        `input[type='radio'][name='bean.title'][value='${value}']`
      ].join(",")).first();
      if (await radio.count().catch(() => 0) === 0) continue;

      await this.markAutomationAction();
      await radio.evaluate((node) => {
        (window as typeof window & { __bochkAutomationIgnoreUntil?: number }).__bochkAutomationIgnoreUntil = Date.now() + 1500;
        const input = node as HTMLInputElement;
        input.scrollIntoView({ block: "center", inline: "center" });
        input.click();
        input.checked = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }).catch(async () => {
        await radio.check({ force: true }).catch(() => undefined);
      });

      const selectedValue = await scope.locator("input[type='radio'][name='bean.title']:checked").first()
        .evaluate((node) => (node as HTMLInputElement).value)
        .catch(() => "");
      if (selectedValue === value) {
        await this.logger.result(`选择称谓成功：${label} value=${value}`);
        return true;
      }
      await this.logger.result(`选择称谓验证失败：目标 ${label} value=${value}，实际 value=${selectedValue || "未选中"}`);
    }

    await this.logger.result(`选择称谓失败：找不到 ${label} 对应 radio`);
    return false;
  }

  private async selectRadioByLabel(selector: string, label: string): Promise<boolean> {
    const radios = await this.allLocators(selector);
    const count = await radios.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const radio = radios.nth(index);
      const radioLabels = await radio.evaluate((input) => {
        const element = input as HTMLInputElement;
        const id = element.id;
        const labels: string[] = [];
        const push = (value: string | null | undefined): void => {
          const normalized = value?.replace(/\s+/g, " ").trim();
          if (normalized) labels.push(normalized);
        };
        push(id ? document.querySelector(`label[for="${id}"]`)?.textContent : "");
        push(element.closest("label")?.textContent);

        let node = element.nextSibling;
        const nextParts: string[] = [];
        for (let step = 0; node && step < 8; step += 1, node = node.nextSibling) {
          if (node instanceof HTMLInputElement && node.type === "radio") break;
          if (node.nodeType === Node.TEXT_NODE) nextParts.push(node.textContent || "");
          if (node instanceof HTMLElement) {
            if (node.matches("input[type='radio']")) break;
            nextParts.push(node.textContent || "");
          }
        }
        push(nextParts.join(" "));

        const parentText = element.parentElement?.textContent?.replace(/\s+/g, " ").trim() || "";
        if (parentText.length <= 36) push(parentText);
        push(element.value);
        return labels;
      }).catch(() => []);
      if (radioLabels.some((radioLabel) => radioLabel.includes(label))) {
        await this.markAutomationAction();
        await radio.check({ force: true }).catch(async () => {
          await radio.evaluate((node) => {
            (window as typeof window & { __bochkAutomationIgnoreUntil?: number }).__bochkAutomationIgnoreUntil = Date.now() + 1500;
            const input = node as HTMLInputElement;
            input.checked = true;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.click();
          }).catch(() => undefined);
        });
        await this.logger.result(`选择 radio 成功：${label}`);
        return true;
      }
    }
    return false;
  }

  private async selectRadioByTextNode(labels: string[]): Promise<{ label: string; value: string; text: string } | undefined> {
    for (const scope of this.allScopes()) {
      const result = await scope.locator("body").evaluate((body, expectedLabels) => {
        const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, "");
        const expected = expectedLabels.map((label) => ({ raw: label, normalized: normalize(label) }));
        const isVisible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const rect = html.getBoundingClientRect();
          const style = window.getComputedStyle(html);
          return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 0 && rect.height >= 0;
        };
        const allRadios = Array.from(body.querySelectorAll<HTMLInputElement>("input[type='radio']"));
        const clickRadio = (radio: HTMLInputElement, match: { raw: string; normalized: string }, text: string) => {
          radio.scrollIntoView({ block: "center", inline: "center" });
          radio.checked = true;
          radio.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          radio.dispatchEvent(new Event("input", { bubbles: true }));
          radio.dispatchEvent(new Event("change", { bubbles: true }));
          return {
            label: match.raw,
            value: radio.value || "",
            text: text.replace(/\s+/g, " ").trim().slice(0, 80),
            checked: radio.checked
          };
        };
        const textWalker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        let node = textWalker.nextNode();
        while (node) {
          const textNode = node;
          const rawText = node.textContent || "";
          const compactText = normalize(rawText);
          const match = expected.find((label) => label.normalized && compactText.includes(label.normalized));
          if (match) {
            const parent = textNode.parentElement;
            const containers = [parent, parent?.parentElement, parent?.closest("tr,li,p,div,td,th,label")]
              .filter(Boolean) as Element[];
            for (const container of containers) {
              const radios = Array.from(container.querySelectorAll<HTMLInputElement>("input[type='radio']"));
              const before = radios
                .filter((radio) => Boolean(radio.compareDocumentPosition(textNode) & Node.DOCUMENT_POSITION_FOLLOWING))
                .pop();
              if (before && isVisible(before)) return clickRadio(before, match, rawText);
              const after = radios
                .find((radio) => Boolean(radio.compareDocumentPosition(textNode) & Node.DOCUMENT_POSITION_PRECEDING));
              if (after && isVisible(after)) return clickRadio(after, match, rawText);
            }

            const beforeAll = allRadios
              .filter((radio) => Boolean(radio.compareDocumentPosition(textNode) & Node.DOCUMENT_POSITION_FOLLOWING))
              .pop();
            if (beforeAll && isVisible(beforeAll)) return clickRadio(beforeAll, match, rawText);
          }
          node = textWalker.nextNode();
        }
        return undefined;
      }, labels).catch(() => undefined);

      if (result?.checked) {
        return {
          label: result.label,
          value: result.value,
          text: result.text
        };
      }
    }
    return undefined;
  }

  private async selectRadioByTextGeometry(labels: string[]): Promise<{ label: string; value: string; text: string } | undefined> {
    for (const scope of this.allScopes()) {
      const result = await scope.locator("body").evaluate((body, expectedLabels) => {
        const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, "");
        const expected = expectedLabels.map((label) => ({ raw: label, normalized: normalize(label) }));
        const isVisible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const rect = html.getBoundingClientRect();
          const style = window.getComputedStyle(html);
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const ownText = (element: Element): string => Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent || "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        const textElements = Array.from(body.querySelectorAll<HTMLElement>("label,td,th,span,p,strong,div"))
          .filter((element) => isVisible(element))
          .map((element) => {
            const directText = ownText(element);
            const text = directText || (element.textContent || "").replace(/\s+/g, " ").trim();
            return { element, text, compactText: normalize(text) };
          })
          .filter((item) => item.text.length <= 80)
          .sort((a, b) => a.text.length - b.text.length);
        const radios = Array.from(body.querySelectorAll<HTMLInputElement>("input[type='radio']"))
          .filter((radio) => isVisible(radio));

        for (const item of textElements) {
          const match = expected.find((label) => label.normalized && item.compactText.includes(label.normalized));
          if (!match) continue;
          const labelRect = item.element.getBoundingClientRect();
          const nearest = radios
            .map((radio) => {
              const rect = radio.getBoundingClientRect();
              const radioCenterY = rect.top + rect.height / 2;
              const labelCenterY = labelRect.top + labelRect.height / 2;
              const sameRowDistance = Math.abs(radioCenterY - labelCenterY);
              const leftDistance = Math.abs(rect.right - labelRect.left);
              const rightPenalty = rect.left > labelRect.left ? 500 : 0;
              return { radio, score: sameRowDistance * 4 + leftDistance + rightPenalty };
            })
            .sort((a, b) => a.score - b.score)[0]?.radio;
          if (!nearest) continue;
          nearest.scrollIntoView({ block: "center", inline: "center" });
          nearest.checked = true;
          nearest.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          nearest.dispatchEvent(new Event("input", { bubbles: true }));
          nearest.dispatchEvent(new Event("change", { bubbles: true }));
          return {
            label: match.raw,
            value: nearest.value || "",
            text: item.text,
            checked: nearest.checked
          };
        }
        return undefined;
      }, labels).catch(() => undefined);

      if (result?.checked) {
        return {
          label: result.label,
          value: result.value,
          text: result.text
        };
      }
    }
    return undefined;
  }

  private async isExpectedSlotSelectionMode(labels: string[]): Promise<boolean> {
    const current = await this.currentSlotSelectionModeText();
    const normalize = (value: string) => value.replace(/\s+/g, "");
    return Boolean(current && labels.some((label) => normalize(current).includes(normalize(label))));
  }

  private async currentSlotSelectionModeText(): Promise<string> {
    for (const scope of this.allScopes()) {
      const text = await scope.locator("body").evaluate(() => {
        const checked = Array.from(document.querySelectorAll<HTMLInputElement>("input[type='radio']:checked"))
          .filter((radio) => !radio.disabled);
        for (const radio of checked) {
          const candidates: string[] = [];
          const labelFor = radio.id ? document.querySelector(`label[for="${radio.id}"]`)?.textContent || "" : "";
          candidates.push(labelFor);
          candidates.push(radio.closest("label")?.textContent || "");
          let node = radio.nextSibling;
          const nextParts: string[] = [];
          for (let step = 0; node && step < 8; step += 1, node = node.nextSibling) {
            if (node instanceof HTMLInputElement && node.type === "radio") break;
            if (node.nodeType === Node.TEXT_NODE) nextParts.push(node.textContent || "");
            if (node instanceof HTMLElement) {
              if (node.matches("input[type='radio']")) break;
              nextParts.push(node.textContent || "");
            }
          }
          candidates.push(nextParts.join(" "));
          const row = radio.closest("tr,li,p,div");
          const rowText = row?.textContent?.replace(/\s+/g, " ").trim() || "";
          if (rowText.length <= 160) candidates.push(rowText);
          const text = candidates.join(" ").replace(/\s+/g, " ").trim();
          if (/先選定|先选定/.test(text)) return text;
        }
        return "";
      }).catch(() => "");
      if (text) return text;
    }
    return "";
  }

  private async slotSelectionRadioSnapshot(): Promise<string> {
    const snapshots: string[] = [];
    for (const scope of this.allScopes()) {
      const snapshot = await scope.locator("body").evaluate(() => {
        const rows = Array.from(document.querySelectorAll<HTMLInputElement>("input[type='radio']"))
          .map((radio) => {
            const parts: string[] = [];
            if (radio.id) parts.push(`#${radio.id}`);
            if (radio.name) parts.push(`name=${radio.name}`);
            if (radio.value) parts.push(`value=${radio.value}`);
            if (radio.checked) parts.push("checked");
            let node = radio.nextSibling;
            const nextParts: string[] = [];
            for (let step = 0; node && step < 6; step += 1, node = node.nextSibling) {
              if (node instanceof HTMLInputElement && node.type === "radio") break;
              nextParts.push(node.textContent || "");
            }
            const text = nextParts.join(" ").replace(/\s+/g, " ").trim();
            if (text) parts.push(`text=${text.slice(0, 40)}`);
            return parts.join(" ");
          })
          .filter((item) => /先選定|先选定|branch|date|time|checked/i.test(item));
        return rows.join(" | ");
      }).catch(() => "");
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots.join(" || ");
  }

  private async selectRadioByVisibleText(labels: string[]): Promise<{ label: string; value: string; text: string } | undefined> {
    for (const scope of this.allScopes()) {
      const result = await scope.locator("body").evaluate((body, expectedLabels) => {
        const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, "");
        const expected = expectedLabels.map((label) => ({
          raw: label,
          normalized: normalize(label)
        }));
        const isVisible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const rect = html.getBoundingClientRect();
          const style = window.getComputedStyle(html);
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const selectRadio = (radio: HTMLInputElement, match: { raw: string; normalized: string }, text: string) => {
          radio.scrollIntoView({ block: "center", inline: "center" });
          radio.checked = true;
          radio.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          radio.dispatchEvent(new Event("input", { bubbles: true }));
          radio.dispatchEvent(new Event("change", { bubbles: true }));
          return {
            label: match.raw,
            value: radio.value || "",
            text: text.replace(/\s+/g, " ").trim().slice(0, 80),
            checked: radio.checked
          };
        };
        const textElements = Array.from(body.querySelectorAll<HTMLElement>("label,td,th,span,div,p,strong"))
          .filter((element) => isVisible(element))
          .map((element) => ({
            element,
            text: element.textContent || "",
            compactText: normalize(element.textContent || "")
          }))
          .filter((item) => expected.some((label) => item.compactText.includes(label.normalized)))
          .sort((a, b) => a.text.length - b.text.length);

        for (const item of textElements) {
          const match = expected.find((label) => item.compactText.includes(label.normalized));
          if (!match) continue;
          const exactOwnText = normalize(Array.from(item.element.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent || "")
            .join(""));
          const textIsBroadContainer = item.text.length > 160 && !exactOwnText.includes(match.normalized);
          if (textIsBroadContainer) continue;

          const labelFor = item.element instanceof HTMLLabelElement ? item.element.htmlFor : "";
          if (labelFor) {
            const radio = body.ownerDocument.getElementById(labelFor);
            if (radio instanceof HTMLInputElement && radio.type === "radio" && isVisible(radio)) {
              return selectRadio(radio, match, item.text);
            }
          }

          const closestLabel = item.element.closest("label");
          const labelRadio = closestLabel?.querySelector<HTMLInputElement>("input[type='radio']");
          if (labelRadio && isVisible(labelRadio)) {
            return selectRadio(labelRadio, match, item.text);
          }

          const row = item.element.closest("tr,li,p,div") || item.element.parentElement;
          const radios = Array.from((row || body).querySelectorAll<HTMLInputElement>("input[type='radio']"))
            .filter((radio) => isVisible(radio));
          if (radios.length === 1) {
            return selectRadio(radios[0], match, item.text);
          }

          const labelRect = item.element.getBoundingClientRect();
          const nearestRadio = radios
            .map((radio) => {
              const rect = radio.getBoundingClientRect();
              const sameRowPenalty = Math.abs((rect.top + rect.height / 2) - (labelRect.top + labelRect.height / 2));
              const leftPenalty = rect.left <= labelRect.left + 20 ? 0 : 300;
              return { radio, score: sameRowPenalty + leftPenalty + Math.abs(rect.right - labelRect.left) / 10 };
            })
            .sort((a, b) => a.score - b.score)[0]?.radio;
          if (nearestRadio) {
            return selectRadio(nearestRadio, match, item.text);
          }
        }

        return undefined;
      }, labels).catch(() => undefined);

      if (result?.checked) {
        return {
          label: result.label,
          value: result.value,
          text: result.text
        };
      }
    }
    return undefined;
  }

  private async selectRadioByPageContext(labels: string[]): Promise<{ label: string; value: string; context: string } | undefined> {
    for (const scope of this.allScopes()) {
      const result = await scope.locator("body").evaluate((body, expectedLabels) => {
        const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, "");
        const expected = expectedLabels.map((label) => ({
          raw: label,
          normalized: normalize(label)
        }));
        const visible = (element: HTMLElement): boolean => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const pushText = (parts: string[], value: string | null | undefined): void => {
          const normalized = value?.replace(/\s+/g, " ").trim();
          if (normalized) parts.push(normalized);
        };
        const contextFor = (radio: HTMLInputElement): string => {
          const parts: string[] = [];
          pushText(parts, radio.id ? document.querySelector(`label[for="${radio.id}"]`)?.textContent : "");
          pushText(parts, radio.closest("label")?.textContent);
          pushText(parts, radio.value);

          let nextNode = radio.nextSibling;
          for (let step = 0; nextNode && step < 14; step += 1, nextNode = nextNode.nextSibling) {
            if (nextNode instanceof HTMLInputElement && nextNode.type === "radio") break;
            if (nextNode.nodeType === Node.TEXT_NODE) pushText(parts, nextNode.textContent);
            if (nextNode instanceof HTMLElement) {
              if (nextNode.matches("input[type='radio']")) break;
              pushText(parts, nextNode.textContent);
            }
          }

          let sibling = radio.nextElementSibling;
          for (let step = 0; sibling && step < 5; step += 1, sibling = sibling.nextElementSibling) {
            if (sibling.matches("input[type='radio']")) break;
            pushText(parts, sibling.textContent);
          }

          const parent = radio.parentElement;
          const parentText = parent?.textContent?.replace(/\s+/g, " ").trim() || "";
          if (parentText.length <= 120) pushText(parts, parentText);
          return parts.join(" ").replace(/\s+/g, " ").trim();
        };

        const radios = Array.from(body.ownerDocument.querySelectorAll<HTMLInputElement>("input[type='radio']"))
          .filter((radio) => visible(radio));
        for (const radio of radios) {
          const context = contextFor(radio);
          const compactContext = normalize(context);
          const match = expected.find((label) => label.normalized && compactContext.includes(label.normalized));
          if (!match) continue;

          radio.scrollIntoView({ block: "center", inline: "center" });
          radio.checked = true;
          radio.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          radio.dispatchEvent(new Event("input", { bubbles: true }));
          radio.dispatchEvent(new Event("change", { bubbles: true }));

          return {
            label: match.raw,
            value: radio.value || "",
            context: context.slice(0, 120),
            checked: radio.checked
          };
        }
        return undefined;
      }, labels).catch(() => undefined);

      if (result?.checked) {
        return {
          label: result.label,
          value: result.value,
          context: result.context
        };
      }
    }
    return undefined;
  }

  private async findRadioByNearbyText(labels: string[]): Promise<Locator | undefined> {
    const radios = await this.allLocators("input[type='radio']");
    const count = await radios.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const radio = radios.nth(index);
      const match = await radio.evaluate((input, expectedLabels) => {
        const element = input as HTMLInputElement;
        const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, "");
        const expected = expectedLabels.map((label) => normalize(label));
        const chunks: string[] = [];
        const push = (value: string | null | undefined): void => {
          const normalized = normalize(value);
          if (normalized) chunks.push(normalized);
        };

        push(element.id ? document.querySelector(`label[for="${element.id}"]`)?.textContent : "");
        push(element.closest("label")?.textContent);

        let node = element.nextSibling;
        const nextParts: string[] = [];
        for (let step = 0; node && step < 10; step += 1, node = node.nextSibling) {
          if (node instanceof HTMLInputElement && node.type === "radio") break;
          if (node.nodeType === Node.TEXT_NODE) nextParts.push(node.textContent || "");
          if (node instanceof HTMLElement) {
            if (node.matches("input[type='radio']")) break;
            nextParts.push(node.textContent || "");
          }
        }
        push(nextParts.join(""));

        let sibling = element.nextElementSibling;
        for (let step = 0; sibling && step < 3; step += 1, sibling = sibling.nextElementSibling) {
          if (sibling.matches("input[type='radio']")) break;
          push(sibling.textContent);
        }

        return chunks.some((chunk) => expected.some((label) => chunk.includes(label)));
      }, labels).catch(() => false);
      if (match) return radio;
    }
    return undefined;
  }

  private async clickIfVisible(selector: string): Promise<boolean> {
    const locator = await this.firstVisibleLocator(selector);
    if (!locator) {
      return false;
    }
    await this.markAutomationAction();
    await locator.click();
    await this.logger.result(`点击成功：${selector}`);
    return true;
  }

  private async fillIfVisible(selector: string, value: string): Promise<boolean> {
    const locator = await this.firstVisibleLocator(selector);
    if (!locator) {
      await this.logger.selector("填写失败，找不到 selector", selector);
      return false;
    }
    await this.markAutomationAction();
    await locator.fill(value);
    await this.logger.result(`填写成功：${selector}`);
    return true;
  }

  private async checkIfVisible(selector: string): Promise<boolean> {
    const locator = await this.firstVisibleLocator(selector);
    if (!locator) {
      await this.logger.selector("勾选失败，找不到 selector", selector);
      return false;
    }
    await this.markAutomationAction();
    await locator.check();
    await this.logger.result(`勾选成功：${selector}`);
    return true;
  }

  private async readConfirmationText(): Promise<string | undefined> {
    const page = this.requirePage();
    for (const selector of bochkSelectors.confirmation) {
      const confirmation = (await this.firstVisibleLocator(selector)) ?? page.locator(selector).first();
      if (await confirmation.isVisible({ timeout: 5000 }).catch(() => false)) {
        return confirmation.textContent().then((text) => text?.trim() || undefined);
      }
    }
    return undefined;
  }

  private async firstVisibleLocator(selector: string, timeout = 8000): Promise<Locator | undefined> {
    await this.logger.selector(`等待 selector 可见，timeout=${timeout}ms`, selector);
    const candidates = this.allScopes().map((scope) => scope.locator(selector).first());
    for (const locator of candidates) {
      if (await locator.isVisible({ timeout }).catch(async (error) => {
        await this.logger.result(`等待 selector 失败：${selector}；${error instanceof Error ? error.message : String(error)}`);
        return false;
      })) {
        return locator;
      }
    }
    if (timeout >= 8000) {
      await this.logger.fail(this.requirePage(), selector, "8000ms 内主页面和 iframe 都没有可见匹配项");
    }
    return undefined;
  }

  private async allLocators(selector: string): Promise<Locator> {
    for (const scope of this.allScopes()) {
      const locator = scope.locator(selector);
      if (await locator.first().isVisible({ timeout: 1000 }).catch(() => false)) {
        return locator;
      }
    }
    return this.requirePage().locator(selector);
  }
}

function dateOptionMatches(label: string, value: string, preferredDate: string): boolean {
  const compact = preferredDate.replaceAll("-", "");
  const slash = preferredDate.replaceAll("-", "/");
  const day = String(Number(preferredDate.slice(-2)));
  const paddedDay = preferredDate.slice(-2);
  const haystack = `${label} ${value}`;

  return haystack.includes(preferredDate)
    || haystack.includes(compact)
    || haystack.includes(slash)
    || new RegExp(`(^|\\D)${paddedDay}(\\D|$)`).test(haystack)
    || new RegExp(`(^|\\D)${day}(\\D|$)`).test(haystack);
}

function looksLikeAppointmentDateValue(value: string): boolean {
  return /\b20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}日?\b/.test(value)
    || /\b\d{1,2}[-/]\d{1,2}[-/](?:20)?\d{2}\b/.test(value)
    || /\b\d{1,2}[-/]\d{1,2}\b/.test(value);
}

function optionLabelMatches(option: SelectOptionSnapshot, preferredLabel: string): boolean {
  const haystack = `${option.label} ${option.value}`.toLowerCase();
  const needle = preferredLabel.toLowerCase();
  const compactHaystack = haystack.replace(/[\s\-_/年月日:.]/g, "");
  const compactNeedle = needle.replace(/[\s\-_/年月日:.]/g, "");
  return haystack.includes(needle) || Boolean(compactNeedle && compactHaystack.includes(compactNeedle));
}

function documentTypeValue(label: string): string | undefined {
  if (/中國居民身份證|中国居民身份证|CNID/i.test(label)) return "CNID";
  if (/香港身份證|香港身份证|HKID/i.test(label)) return "HKID";
  if (/澳門身份證|澳门身份证|MCID/i.test(label)) return "MCID";
  if (/中華人民共和國護照|中华人民共和国护照|CNPT/i.test(label)) return "CNPT";
  if (/護照|护照|passport|OPPT/i.test(label)) return "OPPT";
  return undefined;
}

function accountTypeValue(label: string): string | undefined {
  if (/一般賬戶|一般账户|general|^G$/i.test(label)) return "G";
  if (/特選賬戶|特选账户|^V$/i.test(label)) return "V";
  if (/跨境理財通|跨境理财通|^N$/i.test(label)) return "N";
  return undefined;
}

function hasSuccessPageSignal(text: string): boolean {
  if (/您的預約已成功|您的预约已成功|預約已成功|预约已成功/i.test(text)) {
    return true;
  }
  return /(?:參考編號|参考编号|預約編號|预约编号|Booking Reference|Reference Number|Confirmation Number)[\s\S]{0,80}\b[A-Z][A-Z0-9-]{5,}\b/i.test(text);
}

function hasTimeoutPageSignal(text: string): boolean {
  return /操作(?:已)?逾時|操作(?:已)?逾时|操作(?:已)?超時|操作(?:已)?超时|交易逾時|交易逾时|交易超時|交易超时|session\s+(?:has\s+)?(?:expired|timed\s*out)|request\s+timeout/i.test(text);
}

function currentHalfHourMinute32Cutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setSeconds(0, 0);
  cutoff.setMinutes(32);
  if (now.getMinutes() > 32) {
    cutoff.setHours(cutoff.getHours() + 1);
  }
  return cutoff;
}

export async function detectAppointmentPageType(pageOrFrame: Page | Frame): Promise<AppointmentPageType> {
  const text = await pageOrFrame.locator("body").innerText({ timeout: 2500 }).catch(() => "");
  const fields = await pageOrFrame.locator("input,select,textarea,button,a").evaluateAll((nodes) =>
    nodes.slice(0, 200).map((node) => {
      const element = node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement | HTMLAnchorElement;
      const labels = element.id ? document.querySelector(`label[for="${element.id}"]`)?.textContent || "" : "";
      const options = element.tagName.toLowerCase() === "select"
        ? Array.from((element as HTMLSelectElement).options).map((option) => option.textContent || "").join(" ")
        : "";
      return [
        element.tagName,
        element.getAttribute("name") || "",
        element.id || "",
        element.getAttribute("placeholder") || "",
        element.getAttribute("type") || "",
        element.textContent || "",
        (element as HTMLInputElement).value || "",
        labels,
        options
      ].join(" ");
    }).join("\n")
  ).catch(() => "");
  const haystack = `${pageOrFrame.url()} ${text}\n${fields}`;

  if (hasSuccessPageSignal(haystack)) {
    return "SUCCESS";
  }
  if (/確認資料|确认资料|核對|核对|確認預約|确认预约|請確認|请确认|Confirm/i.test(haystack)) {
    return "CONFIRMATION";
  }
  if (/稱謂|称谓|先生|小姐|太太|女士|姓氏|名字|流動電話|流动电话|手機|手机|電郵|电邮|email|surname|given|mobile|phone/i.test(haystack)) {
    return "CUSTOMER_INFO";
  }
  if (/地區|地区|分行|預約日期|预约日期|日期|時段|时段|時間|时间|district|branch|date|time/i.test(haystack)
    && /select/i.test(fields)) {
    return "SLOT_SELECTION";
  }
  if (/captcha|verify|challenge|驗證碼|验证码|人機驗證|人机验证|robot/i.test(haystack)) {
    return "CAPTCHA";
  }
  return "UNKNOWN";
}

async function buildPageDiagnosis(page: Page): Promise<string> {
  const sections: string[] = [];
  sections.push(`URL: ${page.url()}`);
  sections.push(`TITLE: ${await page.title().catch(() => "")}`);
  const scopes: Array<Page | Frame> = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
  for (const [index, scope] of scopes.entries()) {
    sections.push(`\n=== SCOPE ${index}: ${scope.url()} ===`);
    sections.push("BUTTONS:");
    sections.push(await scope.locator("button,input[type='button'],input[type='submit'],a").evaluateAll((nodes) =>
      nodes.slice(0, 120).map((node) => {
        const element = node as HTMLInputElement | HTMLButtonElement | HTMLAnchorElement;
        return `${element.tagName.toLowerCase()} id=${element.id || ""} name=${element.getAttribute("name") || ""} text=${(element.textContent || (element as HTMLInputElement).value || "").trim()}`;
      }).join("\n")
    ).catch(() => ""));
    sections.push("FIELDS:");
    sections.push(await scope.locator("input,select,textarea").evaluateAll((nodes) =>
      nodes.slice(0, 160).map((node) => {
        const element = node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const optionText = element.tagName.toLowerCase() === "select"
          ? Array.from((element as HTMLSelectElement).options).map((option) => `${option.disabled ? "[disabled]" : ""}${option.value}:${option.textContent?.trim()}`).join(" | ")
          : "";
        return `${element.tagName.toLowerCase()} id=${element.id || ""} name=${element.getAttribute("name") || ""} type=${element.getAttribute("type") || ""} placeholder=${element.getAttribute("placeholder") || ""} value=${(element as HTMLInputElement).value || ""} options=${optionText}`;
      }).join("\n")
    ).catch(() => ""));
    sections.push("VISIBLE TEXT:");
    sections.push((await scope.locator("body").innerText({ timeout: 2500 }).catch(() => "")).slice(0, 5000));
  }
  return sections.join("\n");
}

function extractAppointmentReference(text: string): string | undefined {
  const labeled = labeledValue(text, ["參考編號", "参考编号", "預約編號", "预约编号", "Booking Reference", "Reference Number", "Confirmation Number"]);
  const labeledReference = labeled?.match(/\b[A-Z]?[0-9][A-Z0-9-]{5,}\b/i)?.[0] ?? labeled;
  return labeledReference
    ?? text.match(/(?:參考編號|参考编号|預約編號|预约编号|Booking Reference|Reference Number|Confirmation Number)\s*[:：\t ]+\s*([A-Z0-9-]{6,})/i)?.[1]
    ?? text.match(/\b[A-Z0-9]{6,}(?:-[A-Z0-9]{2,})?\b/i)?.[0];
}

function extractSuccessDetails(
  text: string,
  fallback: Slot | undefined,
  customer: CustomerInfo,
  successScreenshotPath?: string
): BookingSuccessDetails {
  const appointmentDate = normalizeDate(
    labeledValue(text, ["預約日期", "预约日期", "Appointment Date"])
      ?? text.match(/\b20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}日?\b/)?.[0]
  ) ?? fallback?.date;
  const appointmentTime = normalizeTimeValue(
    labeledValue(text, ["預約時間", "预约时间", "Appointment Time"])
      ?? text.match(/\b([01]?\d|2[0-3]):[0-5]\d(?:\s*[-~至到]\s*([01]?\d|2[0-3]):[0-5]\d)?\b/)?.[0]
  ) ?? fallback?.time;
  const branch = labeledValue(text, ["選擇分行", "选择分行", "Selected Branch", "Branch"]) ?? fallback?.branch;
  const district = labeledValue(text, ["分行區域", "分行区域", "District"]) ?? fallback?.district;

  return {
    referenceNumber: extractAppointmentReference(text) ?? "",
    documentType: labeledValue(text, ["您的證件種類", "您的证件种类", "證件種類", "证件种类"]) ?? customer.documentType,
    accountType: labeledValue(text, ["開立賬戶種類", "开立账户种类", "账户种类", "賬戶種類"]) ?? customer.accountType,
    surname: labeledValue(text, ["姓氏"]) ?? customer.surname,
    givenName: labeledValue(text, ["名字"]) ?? customer.givenName,
    countryCode: labeledValue(text, ["國家/區域編號", "国家/区域编号", "國家", "国家"]) ?? customer.countryCode,
    phone: labeledValue(text, ["流動電話號碼", "流动电话号码", "電話號碼", "电话号码"]) ?? customer.phone,
    email: labeledValue(text, ["電郵地址", "电邮地址", "Email", "E-mail"]) ?? customer.email,
    appointmentDate,
    appointmentTime,
    district,
    branch,
    confirmationText: text,
    successScreenshotPath
  };
}

function labeledValue(text: string, labels: string[]): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\u00a0/g, " ").trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const label of labels) {
      if (!line.startsWith(label)) continue;
      const inline = line
        .replace(label, "")
        .replace(/^[\s:：\-\t]+/, "")
        .trim();
      if (inline) return cleanExtractedValue(inline);
      const next = lines[index + 1];
      if (next && !looksLikeLabeledLine(next)) return cleanExtractedValue(next);
    }
  }

  const labelPattern = labels.map(escapeRegExp).join("|");
  const match = text.replace(/\u00a0/g, " ").match(new RegExp(`(?:^|[\\n\\r])\\s*(?:${labelPattern})\\s*[:：\\t ]+([^\\n\\r]+)`, "i"));
  return match?.[1] ? cleanExtractedValue(match[1]) : undefined;
}

function cleanExtractedValue(value: string): string {
  return value.replace(/\s{2,}/g, " ").replace(/^[：:\-\s]+|[：:\-\s]+$/g, "").trim();
}

function looksLikeLabeledLine(value: string): boolean {
  return /^[\p{Script=Han}A-Za-z /]+[\t:：]/u.test(value);
}

function normalizeTimeValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/)?.[0];
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/\b(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?\b/);
  if (!match) return value.trim();
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function parseDateParts(value: string): { year: number; month: number; day: number } | undefined {
  const match = value.match(/\b(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?\b/);
  if (!match) return undefined;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function calendarDateMeta(element: HTMLElement): { text: string; available: boolean } {
  const text = element.textContent?.trim() || "";
  if (!/^\d{1,2}$/.test(text)) {
    return { text, available: false };
  }

  const className = element.className.toString().toLowerCase();
  const style = window.getComputedStyle(element);
  const color = parseRgb(style.color);
  const isDisabled = element.getAttribute("aria-disabled") === "true"
    || element.hasAttribute("disabled")
    || /disabled|unavailable|inactive|off|grey|gray|full|non|not/.test(className)
    || style.pointerEvents === "none"
    || Number(style.opacity || "1") < 0.55;
  if (isDisabled) {
    return { text, available: false };
  }

  const isClickable = Boolean(
    element.closest("a,button,[role='button']")
    || element.getAttribute("onclick")
    || element.querySelector("a,button,[role='button']")
  );
  const isDarkBlue = color ? color.b >= color.r + 25 && color.b >= color.g + 10 && color.r < 80 : false;
  const isNotGrey = color ? Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) > 35 : true;

  return {
    text,
    available: isClickable || (isDarkBlue && isNotGrey)
  };
}

function parseRgb(value: string): { r: number; g: number; b: number } | undefined {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) return undefined;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3])
  };
}

function inferFieldValue(haystack: string, customer: CustomerInfo): string | undefined {
  if (/surname|last|姓氏|姓/i.test(haystack)) return customer.surname;
  if (/given|first|名字|名/i.test(haystack)) return customer.givenName;
  if (/mail|電郵|电邮|邮箱/i.test(haystack)) return customer.email;
  if (/mobile|phone|tel|電話|电话|手機|手机/i.test(haystack)) return customer.phone;
  if (/country|area|國家|国家|區域|区域/i.test(haystack)) return customer.countryCode;
  if (/document|identity|id|證件|证件/i.test(haystack)) return customer.phone.slice(-4);
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
