import { BochkAppointmentBot } from "../bochk/browser.js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DebugLogger, debugEnabled, logSystemDatePhase, logSystemSchedule, logSystemTask } from "../debug/logger.js";
import {
  getBookingDatePhase,
  getFinalChanceAt,
  getNextActiveStart,
  getNextHalfHour,
  getNextNormalCheck,
  getNextReleaseAt,
  getTaskPriority,
  getTimeUntilFinalChance,
  isWithinActiveHours,
  isWithinFocusWindow,
  isWithinReminderWindow,
  sleep
} from "../scheduler.js";
import type { AppointmentTask, BookingResult, TaskStatus } from "../types.js";
import { humanVerificationRegistry } from "./humanVerification.js";
import { TaskStore } from "./store.js";

export class TaskRunner {
  private running = false;
  private stopRequested = false;
  private activeTaskId?: string;

  constructor(private readonly store: TaskStore) {}

  isRunning(): boolean {
    return this.running;
  }

  status(): { running: boolean; activeTaskId?: string } {
    return {
      running: this.running,
      activeTaskId: this.activeTaskId
    };
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  async runOne(taskId: string): Promise<void> {
    if (this.running) {
      return;
    }

    const task = await this.store.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    this.running = true;
    this.stopRequested = false;
    this.activeTaskId = task.id;
    try {
      await this.runTask(task);
    } finally {
      this.activeTaskId = undefined;
      this.running = false;
    }
  }

  async runPending(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.stopRequested = false;
    try {
      while (!this.stopRequested) {
        const task = (await this.store.list()).reverse().find((item) => item.status === "pending");
        if (!task) {
          return;
        }
        this.activeTaskId = task.id;
        await this.runTask(task);
      }
    } finally {
      this.activeTaskId = undefined;
      this.running = false;
    }
  }

  private async runTask(task: AppointmentTask): Promise<void> {
    const startedAt = new Date().toISOString();
    await this.store.update(task.id, {
      startedAt,
      lastMessage: "正在进行调度判断"
    });
    await this.store.appendLog(task.id, "info", "Runner 已启动，先执行通用调度判断");

    const shouldRunExistingFlow = await this.waitForScheduleGate(task.id);
    if (!shouldRunExistingFlow) {
      return;
    }

    const request = this.store.toBookingRequest(task);
    const bot = new BochkAppointmentBot(
      request,
      new DebugLogger(task.id),
      {
        onWaiting: async (message) => {
          await this.store.update(task.id, {
            status: "waiting-human-verification",
            lastMessage: message
          });
          await this.store.appendLog(task.id, "warn", message);
        },
        onContinue: async (message) => {
          await this.store.update(task.id, {
            status: "continuing",
            lastMessage: message
          });
          await this.store.appendLog(task.id, "info", message);
        },
        onStatus: async (status, message) => {
          await this.updateTaskState(task.id, status, message);
        },
        waitForResume: (signal) => humanVerificationRegistry.wait(task.id, signal)
      },
      { taskId: task.id }
    );

    let attempts = task.attempts;
    let keepBrowserOpen = false;
    const logger = new DebugLogger(task.id);
    try {
      await this.updateTaskState(task.id, "PROCESSING", "重点窗口内，进入现有流程入口");
      await this.updateTaskState(task.id, "preparing-first-page", "准备第一页：打开浏览器并填写证件/账户/条款");
      await bot.open();
      await this.store.appendLog(task.id, "info", "单次浏览器会话已打开，开始准备第一页");

      const initialResult = await bot.prepareFirstPage();
      if (initialResult) {
        const handled = await this.handleBookingResult(task.id, initialResult, startedAt, bot);
        if (handled) {
          keepBrowserOpen = initialResult.status === "needs-human";
          return;
        }
      }

      await this.updateTaskState(task.id, "prefilling-after-captcha", "验证码后预填资料：填写后续普通字段");
      const prefillResult = await bot.prefillAfterCaptcha();
      if (prefillResult) {
        const handled = await this.handleBookingResult(task.id, prefillResult, startedAt, bot);
        if (handled) {
          keepBrowserOpen = prefillResult.status === "needs-human";
          return;
        }
      }

      await this.updateTaskState(task.id, "prefilled-waiting-release", "已预填，等待半点放号");
      await logger.result("READY_BEFORE_RELEASE：已预填，等待半点放号");

      while (!this.stopRequested) {
        const now = new Date();
        const nextReleaseAt = getNextReleaseAt(now);
        const windowStart = new Date(nextReleaseAt.getTime() - 10_000);
        const windowFastEnd = new Date(nextReleaseAt.getTime() + 2 * 60_000);
        const windowEnd = windowFastEnd;

        while (!this.stopRequested && Date.now() < windowStart.getTime()) {
          const seconds = Math.max(0, Math.ceil((windowStart.getTime() - Date.now()) / 1000));
          await this.updateTaskState(task.id, "prefilled-waiting-release", `已预填，等待半点放号；${seconds} 秒后开始扫描`);
          await sleep(Math.min(1000, Math.max(250, windowStart.getTime() - Date.now())));
        }

        await this.updateTaskState(task.id, "release-scanning", "高频扫描号源：半点窗口已开始");
        await logger.result(`RELEASE_SCAN：窗口开始 ${windowStart.toISOString()}，目标半点 ${nextReleaseAt.toISOString()}`);

        while (!this.stopRequested && Date.now() <= windowEnd.getTime()) {
          const scanNow = new Date();
          attempts += 1;
          await this.store.update(task.id, {
            attempts,
            status: "release-scanning",
            lastMessage: `第 ${attempts} 次：扫描可预约时段`
          });
          await this.store.appendLog(task.id, "info", `第 ${attempts} 次：扫描可预约时段`);
          await logger.result(`RELEASE_SCAN attempt=${attempts}`);

          const result = await bot.scanReleaseOnce();
          await this.store.appendLog(task.id, result.status === "no-slot" ? "warn" : "info", `第 ${attempts} 次结果：${describeResult(result)}；停在：${bot.getLastStep()}`);

          if (result.status === "booked") {
            await this.updateTaskState(task.id, "final-submitting", "最终提交中：检测到成功结果，保存预约编号");
            await this.completeTask(task.id, result, startedAt);
            return;
          }

          if (result.status === "needs-human") {
            keepBrowserOpen = true;
            await bot.saveTrace();
            await this.updateTaskState(task.id, "needs-human", result.reason);
            await this.store.appendLog(task.id, "warn", `需要人工处理：${result.reason}；停在：${bot.getLastStep()}`);
            return;
          }

          if (/已满|已滿|full|slot/i.test(result.reason)) {
            await this.updateTaskState(task.id, "slot-full-scanning", "号源已满继续扫描");
          }

          const intervalMs = scanNow.getTime() <= windowFastEnd.getTime() ? 1000 : 3000;
          await sleep(intervalMs);
        }

        await this.updateTaskState(task.id, "prefilled-waiting-release", "本次半点窗口结束，继续等待下一个半点");
      }

      await this.store.update(task.id, {
        status: this.stopRequested ? "pending" : "failed",
        lastMessage: this.stopRequested ? "已暂停，等待继续" : "达到最大尝试次数"
      });
      await this.store.appendLog(task.id, this.stopRequested ? "info" : "error", this.stopRequested ? "预约已暂停，等待继续" : "达到最大尝试次数，任务失败");
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      if (debugEnabled()) {
        keepBrowserOpen = true;
        await bot.saveTrace().catch(() => undefined);
      }
      await this.store.update(task.id, {
        status: "failed",
        lastMessage: `${message}；最后步骤：${bot.getLastStep()}`
      });
      await this.store.appendLog(task.id, "error", `运行异常：${message}；最后步骤：${bot.getLastStep()}`);
    } finally {
      if (keepBrowserOpen) {
        await this.store.appendLog(task.id, "warn", "任务需要人工检查，浏览器已保留打开，trace 已保存。");
      } else {
        await bot.close();
      }
    }
  }

  private async updateTaskState(taskId: string, status: TaskStatus, message: string): Promise<void> {
    await this.store.update(taskId, { status, lastMessage: message });
    await this.store.appendLog(taskId, status === "needs-human" ? "warn" : "info", message);
  }

  private async waitForScheduleGate(taskId: string): Promise<boolean> {
    while (!this.stopRequested) {
      const now = new Date();
      const nextNormalCheck = getNextNormalCheck(now);
      const nextHalfHour = getNextHalfHour(now);
      const nextActiveStart = getNextActiveStart(now);
      const activeMode = isWithinActiveHours(now) ? "工作时段" : "休息时段";
      const reminderWindow = isWithinReminderWindow(now);
      const focusWindow = isWithinFocusWindow(now);
      const targetDate = getTargetDate(taskId, await this.store.get(taskId));
      const datePhase = targetDate ? getBookingDatePhase(now, targetDate) : undefined;
      const priority = targetDate ? getTaskPriority(now, targetDate) : "NORMAL";
      const finalChanceAt = targetDate ? getFinalChanceAt(targetDate) : undefined;
      const timeUntilFinalChanceMs = targetDate ? getTimeUntilFinalChance(now, targetDate) : undefined;
      await logSystemSchedule({
        activeMode,
        nextNormalCheck: nextNormalCheck.toISOString(),
        nextHalfHour: nextHalfHour.toISOString(),
        nextActiveStart: nextActiveStart.toISOString(),
        reminderWindow,
        focusWindow
      });
      if (targetDate && datePhase && finalChanceAt) {
        await logSystemDatePhase({
          targetDate,
          phase: datePhase,
          priority,
          finalChanceAt: finalChanceAt.toISOString(),
          timeUntilFinalChanceMs: timeUntilFinalChanceMs ?? 0
        });
      }

      if (priority === "EXPIRED" && targetDate) {
        await logSystemTask("Target date expired, manual review required.");
        await this.store.update(taskId, {
          status: "NEEDS_REVIEW",
          lastProbeResult: "异常",
          inReleaseFocusWindow: false,
          lastMessage: `目标日期 ${targetDate} 已错过最后机会`
        });
        await this.store.appendLog(taskId, "warn", `目标日期 ${targetDate} 已错过最后机会，不再继续该任务`);
        return false;
      }

      if (!isWithinActiveHours(now)) {
        await this.store.update(taskId, {
          status: "SLEEPING",
          nextProbeAt: nextActiveStart.toISOString(),
          inReleaseFocusWindow: false,
          lastMessage: `休息中，下一次恢复时间 ${formatClock(nextActiveStart)}`
        });
        await this.store.appendLog(taskId, "info", `休息时段，不启动实际任务流程；等待到 ${formatClock(nextActiveStart)}`);
        await sleepUntil(nextActiveStart, () => this.stopRequested);
        continue;
      }

      if (priority === "CRITICAL") {
        await this.store.update(taskId, {
          status: "REMINDER_WINDOW",
          inReleaseFocusWindow: true,
          nextProbeAt: nextNormalCheck.toISOString(),
          lastMessage: "目标日期进入最高优先级提醒窗口，请用户重点关注"
        });
        await this.store.appendLog(taskId, "warn", "目标日期前一天 11:25-11:30 最后机会窗口：等待用户手动确认是否开始");
        await this.store.update(taskId, {
          status: "USER_ACTION_REQUIRED",
          lastMessage: "最高优先级提醒：请用户手动确认是否开始准备"
        });
        return false;
      }

      if (priority !== "LOW" && reminderWindow && !focusWindow) {
        await this.store.update(taskId, {
          status: "REMINDER_WINDOW",
          inReleaseFocusWindow: false,
          nextProbeAt: nextNormalCheck.toISOString(),
          lastMessage: "半点前提醒窗口：可以准备预约，请用户手动决定是否开始"
        });
        await this.store.appendLog(taskId, "info", "半点前提醒窗口：不自动推进具体网页流程，等待用户手动点击开始");
        await this.store.update(taskId, {
          status: "USER_ACTION_REQUIRED",
          lastMessage: "请用户手动确认是否开始准备"
        });
        return false;
      }

      if (priority !== "LOW" && focusWindow) {
        await this.store.update(taskId, {
          status: "READY",
          inReleaseFocusWindow: true,
          lastMessage: "重点时间窗口内，允许进入现有流程入口"
        });
        await this.store.appendLog(taskId, "info", "重点时间窗口内，允许调用现有流程入口");
        return true;
      }

      await this.store.update(taskId, {
        status: "NORMAL_CHECK",
        lastProbeAt: now.toISOString(),
        lastProbeResult: "无号",
        nextProbeAt: nextNormalCheck.toISOString(),
        inReleaseFocusWindow: false,
        lastMessage: priority === "LOW"
          ? "低优先级日期阶段：仅执行普通低频检查"
          : priority === "HIGH"
          ? "高优先级日期阶段：普通检查未发现可预约选项，请重点关注"
          : "普通检查模式：本次未发现可预约选项"
      });
      await this.store.appendLog(taskId, "info", "普通检查模式：本次未发现可预约选项；不连续刷新，等待下一次检查");
      await this.store.update(taskId, {
        status: "NO_RESULT",
        lastMessage: `本次未发现可预约选项，下一次普通检查 ${formatClock(nextNormalCheck)}`
      });

      const nextWake = earliestFutureDate([
        nextNormalCheck,
        getReminderWindowStart(now),
        getActiveEnd(now)
      ], now);
      await sleepUntil(nextWake, () => this.stopRequested);
    }

    return false;
  }

  private async handleBookingResult(
    taskId: string,
    result: BookingResult,
    startedAt: string,
    bot: BochkAppointmentBot
  ): Promise<boolean> {
    if (result.status === "booked") {
      await this.completeTask(taskId, result, startedAt);
      return true;
    }

    if (result.status === "needs-human") {
      await bot.saveTrace();
      await this.updateTaskState(taskId, "needs-human", result.reason);
      return true;
    }

    await this.store.appendLog(taskId, "warn", result.reason);
    return false;
  }

  private async completeTask(taskId: string, result: Extract<BookingResult, { status: "booked" }>, startedAt: string): Promise<void> {
    const appointmentNumber = result.referenceNumber || extractAppointmentNumber(result.confirmationText);
    const completedAt = new Date();
    const resultJsonPath = `records/task-${taskId}/result.json`;
    const recordDir = resolve("records", `task-${taskId}`);
    await mkdir(recordDir, { recursive: true });
    await writeFile(resolve(resultJsonPath), `${JSON.stringify({
      ...result.details,
      taskId,
      bookedSlot: result.slot,
      completedAt: completedAt.toISOString()
    }, null, 2)}\n`);
    await this.store.update(taskId, {
      status: appointmentNumber ? "SUCCESS" : "NEEDS_REVIEW",
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - new Date(startedAt).getTime(),
      appointmentNumber,
      referenceNumber: appointmentNumber,
      appointmentDate: result.details.appointmentDate || result.slot.date,
      appointmentTime: result.details.appointmentTime || result.slot.time,
      district: result.details.district || result.slot.district,
      branch: result.details.branch || result.slot.branch,
      confirmationText: result.confirmationText,
      bookedSlot: result.slot,
      resultJsonPath,
      successScreenshotPath: result.details.successScreenshotPath,
      lastMessage: appointmentNumber ? `预约完成，预约编号：${appointmentNumber}` : "检测到确认文本，但没有识别到预约编号，需要人工核对"
    });
    await this.store.appendLog(
      taskId,
      appointmentNumber ? "success" : "warn",
      appointmentNumber ? `预约完成，预约编号：${appointmentNumber}` : "检测到确认文本，但没有识别到预约编号，需要人工核对确认页"
    );
  }
}

function describeResult(result: Awaited<ReturnType<BochkAppointmentBot["tryBookOnce"]>>): string {
  if (result.status === "booked") {
    return "检测到预约成功确认";
  }
  if (result.status === "needs-human") {
    return result.reason;
  }
  return result.reason;
}

function extractAppointmentNumber(text: string): string | undefined {
  return text.match(/(?:預約|预约|編號|编号|reference|ref)[^\dA-Z]{0,12}([A-Z0-9-]{6,})/i)?.[1]
    ?? text.match(/\b[A-Z0-9]{6,}(?:-[A-Z0-9]{2,})?\b/i)?.[0];
}

function getTargetDate(_taskId: string, task: AppointmentTask | undefined): string | undefined {
  return task?.appointment.preferredDates
    ?.map((date) => date.trim())
    .filter(Boolean)
    .sort()[0];
}

async function sleepUntil(target: Date, shouldStop: () => boolean): Promise<void> {
  while (!shouldStop() && Date.now() < target.getTime()) {
    await sleep(Math.min(30_000, Math.max(500, target.getTime() - Date.now())));
  }
}

function earliestFutureDate(dates: Date[], now: Date): Date {
  return dates
    .filter((date) => date.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? new Date(now.getTime() + 60_000);
}

function getReminderWindowStart(now: Date): Date {
  return new Date(getNextHalfHour(now).getTime() - 5 * 60_000);
}

function getActiveEnd(now: Date): Date {
  const end = new Date(now);
  end.setHours(22, 30, 0, 0);
  if (end <= now) {
    end.setDate(end.getDate() + 1);
  }
  return end;
}

function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
