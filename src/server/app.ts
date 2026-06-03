import express from "express";
import { execFile } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanDebugDirectory, debugDirectory, DebugLogger, ensureDebugDirectory, logSystemAction, logSystemSchedule } from "../debug/logger.js";
import {
  getNextActiveStart,
  getNextHalfHour,
  getNextNormalCheck,
  isWithinActiveHours,
  isWithinFocusWindow,
  isWithinReminderWindow
} from "../scheduler.js";
import { humanVerificationRegistry } from "../tasks/humanVerification.js";
import { TaskRunner } from "../tasks/runner.js";
import { TaskStore, type TaskInput } from "../tasks/store.js";
import type { AppointmentTask, BookingResult, TaskStatus } from "../types.js";
import type { BochkAppointmentBot } from "../bochk/browser.js";

await cleanDebugDirectory();

const app = express();
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";
const intakeToken = process.env.INTAKE_TOKEN?.trim();
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const store = new TaskStore(resolve(root, "data/tasks.json"));
const runner = new TaskRunner(store);
type AssistSession = {
  bot: BochkAppointmentBot;
  runId: string;
};

const assistSessions = new Map<string, AssistSession>();
const staleAssistSessionMessage = "辅助浏览器已关闭，请重新启动任务";

function createRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isCurrentAssistSession(taskId: string, runId: string): boolean {
  return assistSessions.get(taskId)?.runId === runId;
}

async function runAssistFillSession(taskId: string): Promise<void> {
  const task = await store.get(taskId);
  if (!task) {
    return;
  }

  const existing = assistSessions.get(task.id);
  if (existing) {
    await logSystemAction({
      taskId: task.id,
      action: "assist-start-ignored-active-session",
      runId: existing.runId
    });
    return;
  }

  const runId = createRunId();
  const { BochkAppointmentBot } = await import("../bochk/browser.js");
  const bot = new BochkAppointmentBot(
    store.toBookingRequest(task),
    new DebugLogger(task.id),
    {
      onWaiting: async (message) => {
        if (!isCurrentAssistSession(task.id, runId)) return;
        await store.update(task.id, {
          status: "waiting-human-verification",
          lastMessage: message
        });
        await store.appendLog(task.id, "warn", message);
      },
      onContinue: async (message) => {
        if (!isCurrentAssistSession(task.id, runId)) return;
        await store.update(task.id, {
          status: "continuing",
          lastMessage: message
        });
        await store.appendLog(task.id, "info", message);
      },
      onStatus: async (status, message) => {
        if (!isCurrentAssistSession(task.id, runId)) return;
        await store.update(task.id, {
          status,
          lastMessage: message
        });
        await store.appendLog(task.id, status === "needs-human" ? "warn" : "info", message);
      },
      waitForResume: (signal) => humanVerificationRegistry.wait(task.id, signal)
    },
    {
      singleScan: true,
      manualScanWindowMs: task.runner.releaseWindowAfterMs,
      taskId: task.id
    }
  );

  assistSessions.set(task.id, { bot, runId });
  let keepBrowserOpen = false;
  try {
    await bot.open();
    const result = await bot.assistFillOnce();
    if (!isCurrentAssistSession(task.id, runId)) {
      await logSystemAction({ event: "ignore-stale-assist-result", taskId: task.id, runId });
      return;
    }
    const message = "reason" in result ? result.reason : result.confirmationText;
    const noSlotMessage = result.status === "no-slot" ? normalizeNoSlotMessage(message) : message;
    keepBrowserOpen = result.status === "needs-human";
    const successPatch = result.status === "booked" ? await saveBookedResult(task, result) : {};
    const resultLogMessage = formatAssistResultLog(result, noSlotMessage);
    const finalStatus = result.status === "booked"
      ? "SUCCESS"
      : result.status === "no-slot"
        ? "NO_RESULT"
        : isSuccessWithoutReference(message)
          ? "NEEDS_REVIEW"
          : "needs-human";
    await store.update(task.id, {
      lastMessage: noSlotMessage,
      status: finalStatus,
      bookedSlot: result.status === "booked" ? result.slot : task.bookedSlot,
      ...successPatch
    });
    await store.appendLog(task.id, result.status === "booked" ? "success" : result.status === "no-slot" ? "warn" : "info", `辅助流程结果：${resultLogMessage}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    const browserWasClosed = /Target page|Target closed|browser has been closed|Browser has been closed|context has been closed|page has been closed/i.test(message);
    keepBrowserOpen = !browserWasClosed;
    if (!isCurrentAssistSession(task.id, runId)) {
      await logSystemAction({ event: "ignore-stale-assist-error", taskId: task.id, runId, error: message });
      return;
    }
    await store.update(task.id, {
      status: "needs-human",
      lastMessage: browserWasClosed
        ? `${staleAssistSessionMessage}。原因：${message}`
        : `辅助流程异常：${message}；请检查浏览器现场`
    });
    await store.appendLog(task.id, "error", `辅助流程异常：${message}`);
  } finally {
    if (!keepBrowserOpen && isCurrentAssistSession(task.id, runId)) {
      await bot.close().catch(() => undefined);
      assistSessions.delete(task.id);
    }
  }
}

async function reconcileAssistSessionState(tasks: AppointmentTask[]): Promise<AppointmentTask[]> {
  let changed = false;

  for (const task of tasks) {
    if (task.status !== "waiting-human-verification" || assistSessions.has(task.id)) {
      continue;
    }

    await store.update(task.id, {
      status: "needs-human",
      lastMessage: staleAssistSessionMessage
    });

    if (task.lastMessage !== staleAssistSessionMessage) {
      await store.appendLog(task.id, "warn", staleAssistSessionMessage);
    }
    changed = true;
  }

  return changed ? store.list() : tasks;
}

function formatAssistResultLog(result: BookingResult, fallbackMessage: string): string {
  if (result.status !== "booked") {
    return fallbackMessage;
  }

  const date = result.details.appointmentDate || result.slot.date || "未识别日期";
  const time = result.details.appointmentTime || result.slot.time || "未识别时间";
  const branch = result.details.branch || result.slot.branch || "未识别网点";
  return `预约成功，预约编号：${result.referenceNumber}，日期：${date}，时间：${time}，办理网点：${branch}`;
}

function decorateDashboardTask(task: AppointmentTask): AppointmentTask & {
  assistSessionActive: boolean;
  humanVerificationWaiting: boolean;
} {
  return {
    ...task,
    assistSessionActive: assistSessions.has(task.id),
    humanVerificationWaiting: humanVerificationRegistry.isWaiting(task.id)
  };
}

function normalizeNoSlotMessage(message: string): string {
  if (/No available dates found|没有可预约日期/i.test(message)) {
    return "没有可预约日期";
  }
  if (/Dates found, but no available time slots|没有可预约时间/i.test(message)) {
    return "有可预约日期，但没有可预约时间";
  }
  if (/Requested times are unavailable|不匹配任务要求/i.test(message)) {
    return "有可预约时间，但不匹配任务要求";
  }
  if (/没有符合条件的区域|區域|区域/i.test(message)) {
    return "有日期和时间，但目标区域没有可用号";
  }
  return message || "没有可预约日期";
}

function isSuccessWithoutReference(message: string): boolean {
  return /成功页|预约成功|預約成功|参考编号|參考編號/i.test(message)
    && /没有提取|未提取|沒有提取|未能提取|没有识别|沒有識別/i.test(message);
}

async function saveBookedResult(
  task: AppointmentTask,
  result: Extract<BookingResult, { status: "booked" }>
): Promise<Partial<AppointmentTask>> {
  const completedAt = new Date().toISOString();
  const resultJsonPath = `records/task-${task.id}/result.json`;
  const recordDir = resolve(root, "records", `task-${task.id}`);
  const recordPath = resolve(root, resultJsonPath);
  const details = {
    ...result.details,
    taskId: task.id,
    bookedSlot: result.slot,
    completedAt
  };

  await mkdir(recordDir, { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(details, null, 2)}\n`);

  return {
    status: "SUCCESS",
    completedAt,
    durationMs: task.startedAt ? new Date(completedAt).getTime() - new Date(task.startedAt).getTime() : undefined,
    referenceNumber: result.referenceNumber,
    appointmentNumber: result.referenceNumber,
    appointmentDate: result.details.appointmentDate || result.slot.date,
    appointmentTime: result.details.appointmentTime || result.slot.time,
    district: result.details.district || result.slot.district,
    branch: result.details.branch || result.slot.branch,
    confirmationText: result.confirmationText,
    resultJsonPath,
    successScreenshotPath: result.details.successScreenshotPath,
    lastMessage: `预约成功，参考编号：${result.referenceNumber}`
  };
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(resolve(root, "public")));
app.use("/records", express.static(resolve(root, "records")));

app.get("/intake", (_req, res) => {
  res.sendFile(resolve(root, "public/intake.html"));
});

app.post("/api/intake", async (req, res, next) => {
  try {
    if (intakeToken && String(req.body?.token ?? req.query.token ?? "").trim() !== intakeToken) {
      res.status(403).json({ error: "Invalid intake token" });
      return;
    }

    const surnameInput = sanitizeText(req.body?.surname);
    const givenNameInput = sanitizeText(req.body?.givenName);
    const fullName = sanitizeText(req.body?.fullName) || `${surnameInput}${givenNameInput}`;
    const phone = sanitizeText(req.body?.phone);
    const email = sanitizeText(req.body?.email);
    const countryCode = sanitizeText(req.body?.countryCode) || "86 中國內地";
    const salutation = sanitizeText(req.body?.salutation) || "先生";
    const documentType = sanitizeText(req.body?.documentType) || "中國居民身份證";
    const accountType = sanitizeText(req.body?.accountType) || "一般賬戶";
    const preferredDate = sanitizeText(req.body?.preferredDate);
    const preferredTimes = normalizeStringArray(req.body?.preferredTimes ?? req.body?.preferredTime);
    const firstPreferredTime = preferredTimes[0] ?? "";
    const district = sanitizeText(req.body?.district);
    const branch = sanitizeText(req.body?.branch);
    const preferredBranches = splitList(branch);
    const selectionMode = sanitizeSelectionMode(req.body?.selectionMode);
    const note = sanitizeText(req.body?.note, 1000);

    const missing = [
      ["fullName", fullName],
      ["phone", phone],
      ["email", email],
      ["preferredDate", preferredDate],
      ["preferredTimes", preferredTimes.length > 0 ? "yes" : ""],
      ["branch", preferredBranches.length > 0 ? "yes" : ""]
    ].filter(([, value]) => !value).map(([field]) => field);

    if (missing.length > 0) {
      res.status(400).json({ error: "Missing required fields", missing });
      return;
    }

    const nameParts = splitChineseName(fullName);
    const surname = surnameInput || nameParts.surname;
    const givenName = givenNameInput || nameParts.givenName;
    const task = await store.create({
      title: sanitizeText(req.body?.title) || `客户提交 - ${fullName} - ${preferredDate} ${firstPreferredTime}`,
      customer: {
        salutation: isValidSalutation(salutation) ? salutation : "先生",
        surname,
        givenName,
        countryCode,
        phone,
        email,
        documentType,
        accountType
      },
      appointment: {
        preferredDistricts: district ? [district] : [],
        preferredBranches,
        preferredDates: [preferredDate],
        preferredTimes,
        selectionMode,
        timeWindows: preferredTimes.map((time) => ({ start: time, end: time })),
        daysAhead: 7
      },
      xianyu: {
        rawConversation: [
          "客户入口提交",
          `證件種類：${documentType}`,
          `開立賬戶種類：${accountType}`,
          `稱謂：${salutation}`,
          `姓名：${surname}${givenName}`,
          `电话：${countryCode} ${phone}`,
          `邮箱：${email}`,
          `区域：${district || "-"}`,
          `网点：${preferredBranches.join("、")}`,
          `日期：${preferredDate}`,
          `时间：${preferredTimes.join("、")}`,
          `选择方式：${selectionMode}`,
          `备注：${note || "-"}`
        ].join("\n")
      },
      fee: 20,
      currency: "HKD"
    });

    await store.appendLog(task.id, "info", "客户入口提交成功，等待后台处理");
    await logSystemAction({
      taskId: task.id,
      action: "client-intake",
      source: "intake"
    });

    res.status(201).json({ ok: true, taskId: task.id });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks", async (_req, res, next) => {
  try {
    const now = new Date();
    await logSystemSchedule({
      nextNormalCheck: getNextNormalCheck(now).toISOString(),
      nextHalfHour: getNextHalfHour(now).toISOString(),
      nextActiveStart: getNextActiveStart(now).toISOString(),
      activeMode: isWithinActiveHours(now) ? "工作时段" : "休息时段",
      reminderWindow: isWithinReminderWindow(now),
      focusWindow: isWithinFocusWindow(now)
    });
    const tasks = await reconcileAssistSessionState(await store.list());
    res.json({
      tasks: tasks.map(decorateDashboardTask),
      summary: await store.summary(),
      runner: runner.status()
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks", async (req, res, next) => {
  try {
    const task = await store.create(req.body as TaskInput);
    res.status(201).json(task);
  } catch (error) {
    next(error);
  }
});

app.put("/api/tasks/:id", async (req, res, next) => {
  try {
    const input = req.body as TaskInput;
    const task = await store.update(req.params.id, {
      title: input.title,
      customer: input.customer,
      appointment: input.appointment,
      runner: input.runner,
      xianyu: input.xianyu,
      fee: Number(input.fee ?? 20),
      currency: input.currency ?? "HKD",
      lastMessage: "任务资料已更新"
    });
    res.json(task);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/tasks/:id", async (req, res, next) => {
  try {
    const session = assistSessions.get(req.params.id);
    if (session) {
      await session.bot.close().catch(() => undefined);
      assistSessions.delete(req.params.id);
    }
    humanVerificationRegistry.clearPending(req.params.id);
    await store.remove(req.params.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:id/reset", async (req, res, next) => {
  try {
    res.json(await store.resetToPending(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:id/start-prepare", async (req, res, next) => {
  try {
    res.json(await applyManualTaskAction(req.params.id, "start-prepare", "PREPARING", "用户选择开始准备"));
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:id/continue", async (req, res, next) => {
  try {
    res.json(await applyManualTaskAction(req.params.id, "continue", "READY", "用户已处理问题，任务回到就绪状态"));
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:id/pause", async (req, res, next) => {
  try {
    res.json(await applyManualTaskAction(req.params.id, "pause", "IDLE", "用户暂停任务，等待下一次手动启动"));
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:id/mark-success", async (req, res, next) => {
  try {
    res.json(await applyManualTaskAction(req.params.id, "mark-success", "SUCCESS", "用户手动标记任务完成", {
      completedAt: new Date().toISOString()
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:id/mark-failed", async (req, res, next) => {
  try {
    res.json(await applyManualTaskAction(req.params.id, "mark-failed", "FAILED", "用户手动标记任务失败"));
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:id/skip-date", async (req, res, next) => {
  try {
    res.json(await applyManualTaskAction(req.params.id, "skip-date", "NEEDS_REVIEW", "用户选择跳过该目标日期", {
      skippedTargetDate: true
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:id/record-result", async (req, res, next) => {
  try {
    console.log("[record-api] body =", req.body);
    const task = await store.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const referenceNumber = String(req.body?.referenceNumber ?? "").trim();
    if (!referenceNumber) {
      res.status(400).json({ error: "referenceNumber is required" });
      return;
    }

    const completedAt = new Date().toISOString();
    const appointmentDate = String(req.body?.appointmentDate ?? "").trim();
    const appointmentTime = String(req.body?.appointmentTime ?? "").trim();
    const district = String(req.body?.district ?? "").trim();
    const branch = String(req.body?.branch ?? "").trim();
    const confirmationText = String(req.body?.confirmationText ?? "").trim() || "手动记录：未提供确认页全文";
    const successScreenshotPath = String(req.body?.successScreenshotPath ?? "").trim();
    console.log("[record-api] successScreenshotPath =", successScreenshotPath);
    const resultJsonPath = `records/task-${task.id}/result.json`;
    const recordDir = resolve(root, "records", `task-${task.id}`);
    const recordPath = resolve(root, resultJsonPath);
    const result = {
      taskId: task.id,
      referenceNumber,
      appointmentDate,
      appointmentTime,
      district,
      branch,
      confirmationText,
      successScreenshotPath,
      completedAt
    };

    await mkdir(recordDir, { recursive: true });
    await writeFile(recordPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log("[record-api] result file written =", recordPath);

    const recordPatch = {
      status: "SUCCESS" as const,
      referenceNumber,
      appointmentNumber: referenceNumber,
      appointmentDate,
      appointmentTime,
      district,
      branch,
      confirmationText,
      completedAt,
      resultJsonPath,
      successScreenshotPath,
      lastMessage: `已记录成功结果：${referenceNumber}`
    };
    const updated = await store.update(task.id, recordPatch);
    console.log("[record-api] updated task =", updated);
    await store.appendLog(task.id, "success", `已记录成功结果：${referenceNumber}`);

    const recordLog = `[RECORD] taskId=${task.id} referenceNumber=${referenceNumber} resultJsonPath=${resultJsonPath}`;
    console.log(recordLog);
    await mkdir(debugDirectory(), { recursive: true });
    await appendFile(resolve(debugDirectory(), "run.log"), `${recordLog}\n`);

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post("/api/debug/clear", async (_req, res, next) => {
  try {
    await cleanDebugDirectory();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/debug/open", async (_req, res, next) => {
  try {
    await ensureDebugDirectory();
    execFile("open", [debugDirectory()], (error) => {
      if (error) {
        console.error(`Open debug directory failed: ${error.message}`);
      }
    });
    res.json({ ok: true, path: debugDirectory() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:id/assist-fill", async (req, res, next) => {
  try {
    const task = await store.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const existing = assistSessions.get(task.id);
    if (existing) {
      const message = task.status === "waiting-human-verification"
        ? "辅助流程正在等待验证码，请输入验证码后点击“我已完成验证码，继续执行”。"
        : "辅助流程正在运行，请不要重复启动；如需中断请先手动恢复启动按钮。";
      await store.update(task.id, { lastMessage: message });
      await store.appendLog(task.id, "warn", message);
      await logSystemAction({
        taskId: task.id,
        action: "assist-start-blocked-active-session",
        runId: existing.runId,
        status: task.status
      });
      res.status(409).json({ error: message, active: true });
      return;
    }
    humanVerificationRegistry.clearPending(task.id);
    await store.update(task.id, {
      status: "continuing",
      lastMessage: "辅助流程已启动：等待验证码后将自动填资料并扫描号源"
    });
    await store.appendLog(task.id, "info", "辅助流程已启动：等待验证码后将自动填资料并扫描号源");
    void runAssistFillSession(task.id);
    res.json({ ok: true, started: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:id/continue-verification", async (req, res, next) => {
  try {
    const task = await store.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    if (!assistSessions.has(task.id)) {
      await store.update(task.id, {
        status: "needs-human",
        lastMessage: staleAssistSessionMessage
      });
      await store.appendLog(task.id, "warn", staleAssistSessionMessage);
      res.status(409).json({ error: "当前任务没有正在运行的辅助会话，请点击“启动任务”。" });
      return;
    }
    const resumedImmediately = humanVerificationRegistry.resume(task.id);
    await store.update(task.id, {
      status: "continuing",
      lastMessage: resumedImmediately
        ? "已收到验证码完成信号，正在继续当前任务"
        : "已记录验证码完成信号，等待辅助流程接收"
    });
    await store.appendLog(
      task.id,
      "info",
      resumedImmediately
        ? "已从 Dashboard 收到验证码完成信号，继续执行当前任务"
        : "已从 Dashboard 收到验证码完成信号，等待辅助流程接收"
    );
    res.json({ ok: true, resumed: resumedImmediately, taskId: task.id });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:id/force-unlock", async (req, res, next) => {
  try {
    const task = await store.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const session = assistSessions.get(task.id);
    if (session) {
      await session.bot.close().catch(() => undefined);
      assistSessions.delete(task.id);
    }
    humanVerificationRegistry.clearPending(task.id);

    const message = "已手动恢复启动按钮，可重新启动任务";
    const updated = await store.update(task.id, {
      status: "needs-human",
      lastMessage: message
    });
    await store.appendLog(task.id, "warn", message);
    await logSystemAction({
      taskId: task.id,
      action: "force-unlock",
      oldStatus: task.status,
      newStatus: "needs-human"
    });

    res.json(decorateDashboardTask(updated));
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:id/chrome-fill-script", async (req, res, next) => {
  try {
    const task = await store.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.type("text/plain").send(buildChromeFillScript(task));
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:id/start", async (req, res, next) => {
  try {
    const task = await store.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (runner.isRunning()) {
      res.status(409).json({ error: "Runner is already running" });
      return;
    }
    await store.update(task.id, {
      status: "pending",
      lastMessage: "已加入预约执行，正在启动浏览器"
    });
    void runner.runOne(task.id);
    res.json(runner.status());
  } catch (error) {
    next(error);
  }
});

app.post("/api/runner/start", async (_req, res, next) => {
  try {
    const tasks = await store.list();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const eligible = tasks.filter((task) => {
      if (["SUCCESS", "completed", "FAILED", "failed"].includes(task.status)) return false;
      const targetDate = task.appointment.preferredDates?.filter(Boolean).sort()[0];
      if (!targetDate) return true;
      return new Date(`${targetDate}T00:00:00`).getTime() >= today.getTime();
    });

    for (const task of eligible) {
      if (task.status !== "pending") {
        await store.update(task.id, {
          status: "pending",
          lastMessage: "已加入批量预约执行队列"
        });
      }
    }

    void runner.runPending();
    res.json({ ...runner.status(), queuedTasks: eligible.length });
  } catch (error) {
    next(error);
  }
});

app.post("/api/runner/stop", (_req, res) => {
  runner.requestStop();
  res.json(runner.status());
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown server error";
  res.status(500).json({ error: message });
});

app.listen(port, host, () => {
  console.log(`Dashboard: http://${host}:${port}`);
  console.log(`Client intake: http://${host}:${port}/intake`);
});

function sanitizeText(value: unknown, maxLength = 120): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function splitChineseName(fullName: string): { surname: string; givenName: string } {
  const cleaned = fullName.trim();
  if (/^[A-Za-z\s]+$/.test(cleaned)) {
    const parts = cleaned.split(/\s+/).filter(Boolean);
    return {
      surname: parts[0] ?? "",
      givenName: parts.slice(1).join(" ")
    };
  }
  return {
    surname: cleaned.slice(0, 1),
    givenName: cleaned.slice(1)
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeText(item)).filter(Boolean);
  }
  const text = sanitizeText(value);
  return text ? [text] : [];
}

function splitList(value: unknown): string[] {
  return String(value ?? "")
    .split(/[,，、;；\n]/)
    .map((item) => sanitizeText(item))
    .filter(Boolean);
}

function sanitizeSelectionMode(value: unknown): "date-first" | "branch-first" {
  return value === "branch-first" ? "branch-first" : "date-first";
}

function isValidSalutation(value: string): value is "先生" | "小姐" | "太太" | "女士" {
  return ["先生", "小姐", "太太", "女士"].includes(value);
}

async function applyManualTaskAction(
  taskId: string,
  action: string,
  newStatus: TaskStatus,
  message: string,
  extraPatch: Partial<AppointmentTask> = {}
): Promise<AppointmentTask> {
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const oldStatus = task.status;
  const updated = await store.update(taskId, {
    ...extraPatch,
    status: newStatus,
    lastMessage: message
  });
  await store.appendLog(taskId, "info", message);
  await logSystemAction({
    taskId,
    action,
    oldStatus,
    newStatus
  });
  return updated;
}

type ScriptTask = NonNullable<Awaited<ReturnType<TaskStore["get"]>>>;

function buildChromeFillScript(task: ScriptTask): string {
  const payload = {
    customer: task.customer,
    appointment: task.appointment
  };

  return `(() => {
  const task = ${JSON.stringify(payload)};
  const logs = [];
  const log = (ok, message) => logs.push((ok ? "✓ " : "✕ ") + message);
  const fire = (el) => ["input", "change", "blur"].forEach((name) => el.dispatchEvent(new Event(name, { bubbles: true })));
  const byText = (selector, text) => [...document.querySelectorAll(selector)].find((el) => (el.textContent || "").includes(text));
  const valueMap = {
    documentType: {
      "香港身份證": "HKID",
      "中國居民身份證": "CNID",
      "中華人民共和國護照": "CNPT",
      "澳門身份證": "MCID",
      "護照": "OPPT",
      "其他護照": "OPPT"
    },
    accountType: {
      "一般賬戶": "G",
      "特選賬戶": "V",
      "跨境理財通:北向通匯款專戶": "N"
    }
  };
  const setSelect = (selectors, value, label, name) => {
    const select = selectors.map((s) => document.querySelector(s)).find(Boolean);
    if (!select) return log(false, name + "：找不到下拉框");
    const target = value || [...select.options].find((option) => option.textContent.includes(label))?.value;
    if (!target) return log(false, name + "：找不到选项 " + label);
    select.value = target;
    fire(select);
    log(select.value === target, name + "：" + (select.options[select.selectedIndex]?.textContent || select.value));
  };
  const fill = (selectors, value, name) => {
    if (!value) return log(false, name + "：任务没有提供");
    const input = selectors.map((s) => document.querySelector(s)).find(Boolean);
    if (!input) return log(false, name + "：找不到输入框");
    input.focus();
    input.value = value;
    fire(input);
    log(true, name + "：已填写");
  };
  const check = (selectors, name) => {
    const input = selectors.map((s) => document.querySelector(s)).find(Boolean);
    if (!input) return log(false, name + "：找不到勾选框");
    input.checked = true;
    fire(input);
    log(input.checked, name + "：已勾选");
  };
  const chooseRadio = (label, name) => {
    const radio = [...document.querySelectorAll("input[type=radio]")].find((input) => {
      const idLabel = input.id ? document.querySelector("label[for='" + input.id + "']")?.textContent : "";
      const near = input.closest("label")?.textContent || input.parentElement?.textContent || input.value;
      return (idLabel || near || "").includes(label);
    });
    if (!radio) return log(false, name + "：找不到 " + label);
    radio.checked = true;
    fire(radio);
    log(true, name + "：" + label);
  };
  const chooseSalutation = (label) => {
    const valueMap = { "先生": "1", "小姐": "2", "太太": "3", "女士": "4" };
    const value = valueMap[label];
    const radio = document.querySelector("#eAAOForm_title_field" + value)
      || document.querySelector("input[type=radio][name='bean.title'][value='" + value + "']");
    if (!radio) return log(false, "稱謂：找不到 " + label);
    radio.click();
    radio.checked = true;
    fire(radio);
    const checked = document.querySelector("input[type=radio][name='bean.title']:checked");
    log(checked?.value === value, "稱謂：" + label);
  };

  if (location.hostname !== "transaction.bochk.com") {
    const iframe = document.querySelector("#iframe");
    log(false, "当前在外层 BOCHK 页面，外层页面不能直接操作跨域 iframe。请打开真实表单页：https://transaction.bochk.com/whk/form/openAccount/input.action?lang=zh_HK 后再运行本脚本。");
    if (iframe?.src) log(false, "检测到真实表单 iframe：" + iframe.src);
    alert(logs.join("\\n"));
    return;
  }

  setSelect(["#eAAOForm_idType_field", "select[name='bean.idType']"], valueMap.documentType[task.customer.documentType], task.customer.documentType, "證件種類");
  setSelect(["#eAAOForm_serviceAccountType_field", "select[name='bean.serviceAccountType']"], valueMap.accountType[task.customer.accountType], task.customer.accountType, "開立賬戶種類");
  check(["#mortgageLoans_form_acceptTerms_field", "input[name='acceptTerms']"], "資料政策同意");

  chooseSalutation(task.customer.salutation);
  fill(["input[name*='surname']", "input[id*='surname']", "input[name*='last']", "input[id*='last']"], task.customer.surname, "姓氏");
  fill(["input[name*='given']", "input[id*='given']", "input[name*='first']", "input[id*='first']"], task.customer.givenName, "名字");
  setSelect(["select[name*='country']", "select[id*='country']", "select[name*='area']", "select[id*='area']"], undefined, task.customer.countryCode, "國家/區域編號");
  fill(["input[name*='mobile']", "input[id*='mobile']", "input[name*='phone']", "input[id*='phone']", "input[type='tel']"], task.customer.phone, "流動電話號碼");
  fill(["input[type='email']", "input[name*='email']", "input[id*='email']"], task.customer.email, "電郵地址");

  if (document.querySelector("#captcha_img, input[name*='captcha'], input[name*='verify']")) {
    log(false, "检测到验证码/验证输入：请手动完成，我不会自动破解验证码。");
  }

  const continueButton = document.querySelector("#eAAOForm_submit_button");
  if (continueButton && confirm(logs.join("\\n") + "\\n\\n是否点击「繼續」进入下一步？")) {
    continueButton.click();
  } else {
    alert(logs.join("\\n"));
  }
})();`;
}
