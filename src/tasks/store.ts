import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeTaskStatus } from "../types.js";
import type {
  AppointmentTask,
  BookingRequest,
  DashboardSummary,
  TaskLogEntry,
} from "../types.js";
import { defaultRunnerConfig } from "../defaults.js";
import { logSystemStateChange } from "../debug/logger.js";

const DATA_FILE = "data/tasks.json";

type StoredData = {
  tasks: AppointmentTask[];
};

export type TaskInput = Omit<
  Partial<AppointmentTask>,
  "id" | "status" | "createdAt" | "startedAt" | "completedAt" | "durationMs" | "attempts"
> & {
  title: string;
};

export class TaskStore {
  constructor(private readonly path = DATA_FILE) {}

  async list(): Promise<AppointmentTask[]> {
    const data = await this.read();
    return data.tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<AppointmentTask | undefined> {
    const data = await this.read();
    return data.tasks.find((task) => task.id === id);
  }

  async create(input: TaskInput): Promise<AppointmentTask> {
    const data = await this.read();
    const now = new Date().toISOString();
    const task: AppointmentTask = {
      id: randomUUID(),
      title: input.title,
      customer: input.customer ?? {
        salutation: "先生",
        surname: "",
        givenName: "",
        countryCode: "852 香港",
        phone: "",
        email: "",
        documentType: "中國居民身份證",
        accountType: "一般賬戶"
      },
      appointment: input.appointment ?? {
        preferredDistricts: [],
        preferredBranches: [],
        preferredDates: [],
        preferredTimes: ["09:00", "09:45", "10:30", "11:15", "14:00", "14:45", "15:30", "16:15"],
        selectionMode: "date-first",
        timeWindows: [{ start: "09:00", end: "17:00" }],
        daysAhead: 7
      },
      runner: { ...defaultRunnerConfig, ...input.runner },
      xianyu: input.xianyu,
      fee: Number(input.fee ?? 20),
      currency: input.currency ?? "HKD",
      status: "pending",
      createdAt: now,
      attempts: 0,
      lastMessage: "等待预约",
      logs: [
        {
          at: now,
          level: "info",
          message: "任务已创建，等待预约"
        }
      ]
    };
    data.tasks.push(task);
    await this.write(data);
    return task;
  }

  async update(id: string, patch: Partial<AppointmentTask>): Promise<AppointmentTask> {
    const data = await this.read();
    const index = data.tasks.findIndex((task) => task.id === id);
    if (index < 0) {
      throw new Error(`Task not found: ${id}`);
    }
    const oldStatus = data.tasks[index].status;
    data.tasks[index] = { ...data.tasks[index], ...patch };
    await this.write(data);
    if (patch.status && patch.status !== oldStatus) {
      await logSystemStateChange(oldStatus, patch.status);
    }
    return data.tasks[index];
  }

  async appendLog(id: string, level: TaskLogEntry["level"], message: string): Promise<AppointmentTask> {
    const data = await this.read();
    const index = data.tasks.findIndex((task) => task.id === id);
    if (index < 0) {
      throw new Error(`Task not found: ${id}`);
    }
    const logs = data.tasks[index].logs ?? [];
    data.tasks[index] = {
      ...data.tasks[index],
      logs: [...logs, { at: new Date().toISOString(), level, message }].slice(-120),
      lastMessage: message
    };
    await this.write(data);
    return data.tasks[index];
  }

  async remove(id: string): Promise<void> {
    const data = await this.read();
    data.tasks = data.tasks.filter((task) => task.id !== id);
    await this.write(data);
  }

  async resetToPending(id: string): Promise<AppointmentTask> {
    return this.update(id, {
      status: "pending",
      startedAt: undefined,
      completedAt: undefined,
      durationMs: undefined,
      attempts: 0,
      appointmentNumber: undefined,
      confirmationText: undefined,
      bookedSlot: undefined,
      lastMessage: "已重置，等待预约"
    });
  }

  async summary(): Promise<DashboardSummary> {
    const tasks = await this.list();
    const completed = tasks.filter((task) => normalizeTaskStatus(task.status) === "SUCCESS");
    const completedDurations = completed
      .map((task) => task.durationMs ?? 0)
      .filter((duration) => duration > 0);

    return {
      totalTasks: tasks.length,
      pendingTasks: tasks.filter((task) => normalizeTaskStatus(task.status) === "IDLE").length,
      runningTasks:
        tasks.filter((task) => normalizeTaskStatus(task.status) === "PROCESSING" || normalizeTaskStatus(task.status) === "PREPARING").length,
      completedTasks: completed.length,
      needsHumanTasks: tasks.filter((task) => normalizeTaskStatus(task.status) === "NEEDS_REVIEW" || normalizeTaskStatus(task.status) === "USER_ACTION_REQUIRED").length,
      failedTasks: tasks.filter((task) => normalizeTaskStatus(task.status) === "FAILED").length,
      completionRate: tasks.length > 0 ? completed.length / tasks.length : 0,
      totalRevenue: sum(tasks.map((task) => task.fee)),
      completedRevenue: sum(completed.map((task) => task.fee)),
      averageCompletionMs:
        completedDurations.length > 0 ? sum(completedDurations) / completedDurations.length : 0
    };
  }

  toBookingRequest(task: AppointmentTask): BookingRequest {
    return {
      customer: task.customer,
      appointment: {
        ...task.appointment,
        selectionMode: task.appointment.selectionMode ?? "date-first"
      },
      runner: task.runner,
      xianyu: task.xianyu
    };
  }

  private async read(): Promise<StoredData> {
    try {
      const raw = await readFile(this.path, "utf8");
      return JSON.parse(raw) as StoredData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return { tasks: [] };
    }
  }

  private async write(data: StoredData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(data, null, 2)}\n`);
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
