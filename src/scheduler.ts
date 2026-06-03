import type { BookingDatePhase, BookingRequest, TaskPriority } from "./types.js";

export type SchedulerConfig = {
  activeStartHour?: number;
  activeStartMinute?: number;
  activeEndHour?: number;
  activeEndMinute?: number;
  reminderWindowMinutes?: number;
  focusWindowBeforeMinutes?: number;
  focusWindowAfterMinutes?: number;
  normalCheckMinMinutes?: number;
  normalCheckMaxMinutes?: number;
};

const defaultSchedulerConfig: Required<SchedulerConfig> = {
  activeStartHour: 7,
  activeStartMinute: 0,
  activeEndHour: 22,
  activeEndMinute: 30,
  reminderWindowMinutes: 5,
  focusWindowBeforeMinutes: 5,
  focusWindowAfterMinutes: 1,
  normalCheckMinMinutes: 10,
  normalCheckMaxMinutes: 15
};

export type ReleaseWindowState = {
  inReleaseWindow: boolean;
  nextReleaseAt: Date;
  refreshIntervalMs: number;
};

export type OperatingWindowState = {
  isWorkingHours: boolean;
  nextResumeAt: Date;
  modeLabel: "工作时段" | "休息时段";
};

export function getReleaseWindowState(now: Date, request: BookingRequest): ReleaseWindowState {
  const nextReleaseAt = getNextReleaseAt(now);
  const previousReleaseAt = new Date(nextReleaseAt.getTime() - 60 * 60 * 1000);
  const windowStart = previousReleaseAt.getTime() - request.runner.releaseWindowBeforeMs;
  const windowEnd = previousReleaseAt.getTime() + Math.min(request.runner.releaseWindowAfterMs, 120_000);
  const inReleaseWindow = now.getTime() >= windowStart && now.getTime() <= windowEnd;

  return {
    inReleaseWindow,
    nextReleaseAt,
    refreshIntervalMs: inReleaseWindow
      ? request.runner.releaseWindowRefreshIntervalMs
      : Math.min(request.runner.normalRefreshIntervalMs, Math.max(1000, nextReleaseAt.getTime() - now.getTime()))
  };
}

export function getNextReleaseAt(now: Date): Date {
  return getNextHalfHour(now);
}

export function getOperatingWindowState(now: Date): OperatingWindowState {
  const isWorkingHours = isWithinActiveHours(now);
  return {
    isWorkingHours,
    nextResumeAt: getNextActiveStart(now),
    modeLabel: isWorkingHours ? "工作时段" : "休息时段"
  };
}

export function isReleaseWarmupWindow(now: Date): boolean {
  return isWithinReminderWindow(now);
}

export function isReleaseFocusWindow(now: Date): boolean {
  return isWithinFocusWindow(now);
}

export function getNextNormalProbeAt(now: Date): Date {
  return getNextNormalCheck(now);
}

export function normalProbeIntervalMs(now: Date): number {
  return getNextNormalCheck(now).getTime() - now.getTime();
}

export function isWithinActiveHours(now: Date, config: SchedulerConfig = {}): boolean {
  const resolved = resolveSchedulerConfig(config);
  const activeStart = dateAtTime(now, resolved.activeStartHour, resolved.activeStartMinute);
  const activeEnd = dateAtTime(now, resolved.activeEndHour, resolved.activeEndMinute);
  return now >= activeStart && now < activeEnd;
}

export function getNextActiveStart(now: Date, config: SchedulerConfig = {}): Date {
  const resolved = resolveSchedulerConfig(config);
  const todayStart = dateAtTime(now, resolved.activeStartHour, resolved.activeStartMinute);
  if (now < todayStart) {
    return todayStart;
  }

  const nextStart = new Date(todayStart);
  nextStart.setDate(nextStart.getDate() + 1);
  return nextStart;
}

export function getNextHalfHour(now: Date): Date {
  const next = new Date(now);
  next.setSeconds(0, 0);
  if (next.getMinutes() < 30) {
    next.setMinutes(30);
  } else {
    next.setHours(next.getHours() + 1, 30);
  }
  return next;
}

export function isWithinReminderWindow(now: Date, config: SchedulerConfig = {}): boolean {
  const resolved = resolveSchedulerConfig(config);
  const nextHalfHour = getNextHalfHour(now);
  const reminderStart = new Date(nextHalfHour.getTime() - resolved.reminderWindowMinutes * 60_000);
  return now >= reminderStart && now < nextHalfHour;
}

export function isWithinFocusWindow(now: Date, config: SchedulerConfig = {}): boolean {
  const resolved = resolveSchedulerConfig(config);
  const nextHalfHour = getNextHalfHour(now);
  const previousHalfHour = new Date(nextHalfHour.getTime() - 60 * 60_000);
  const nextWindowStart = new Date(nextHalfHour.getTime() - resolved.focusWindowBeforeMinutes * 60_000);
  const nextWindowEnd = new Date(nextHalfHour.getTime() + resolved.focusWindowAfterMinutes * 60_000);
  const previousWindowStart = new Date(previousHalfHour.getTime() - resolved.focusWindowBeforeMinutes * 60_000);
  const previousWindowEnd = new Date(previousHalfHour.getTime() + resolved.focusWindowAfterMinutes * 60_000);
  return (now >= nextWindowStart && now <= nextWindowEnd)
    || (now >= previousWindowStart && now <= previousWindowEnd);
}

export function getNextNormalCheck(now: Date, config: SchedulerConfig = {}): Date {
  const resolved = resolveSchedulerConfig(config);
  const min = Math.min(resolved.normalCheckMinMinutes, resolved.normalCheckMaxMinutes);
  const max = Math.max(resolved.normalCheckMinMinutes, resolved.normalCheckMaxMinutes);
  const randomMinutes = min + Math.random() * (max - min);
  return new Date(now.getTime() + randomMinutes * 60_000);
}

export function getBookingDatePhase(now: Date, targetDate: Date | string): BookingDatePhase {
  const target = parseTargetDate(targetDate);
  const dayDiff = differenceInCalendarDays(target, now);
  if (dayDiff > 2) return "TOO_EARLY";
  if (dayDiff === 2) return "MAIN_RELEASE_DAY";
  if (dayDiff === 1) {
    const finalChanceAt = getFinalChanceAt(target);
    const finalWindowStart = new Date(finalChanceAt.getTime() - 5 * 60_000);
    if (now > finalChanceAt) return "EXPIRED";
    if (now >= finalWindowStart && now <= finalChanceAt) return "FINAL_CHANCE_WINDOW";
    return "FINAL_CHANCE_BEFORE_1130";
  }
  if (dayDiff === 0) return "SAME_DAY";
  return "EXPIRED";
}

export function getTaskPriority(now: Date, targetDate: Date | string): TaskPriority {
  const phase = getBookingDatePhase(now, targetDate);
  if (phase === "TOO_EARLY") return "LOW";
  if (phase === "MAIN_RELEASE_DAY" || phase === "FINAL_CHANCE_BEFORE_1130") return "HIGH";
  if (phase === "FINAL_CHANCE_WINDOW") return "CRITICAL";
  if (phase === "EXPIRED" || phase === "SAME_DAY") return "EXPIRED";
  return "NORMAL";
}

export function getFinalChanceAt(targetDate: Date | string): Date {
  const target = parseTargetDate(targetDate);
  const finalChanceAt = startOfLocalDay(target);
  finalChanceAt.setDate(finalChanceAt.getDate() - 1);
  finalChanceAt.setHours(11, 30, 0, 0);
  return finalChanceAt;
}

/**
 * Returns milliseconds until the final chance. A negative value means the final chance time has passed.
 */
export function getTimeUntilFinalChance(now: Date, targetDate: Date | string): number {
  return getFinalChanceAt(targetDate).getTime() - now.getTime();
}

export function runSchedulerSelfTest(): Array<{ name: string; passed: boolean }> {
  const at = (time: string) => new Date(`2026-05-09T${time}:00`);
  const targetDate = "2026-05-20";
  return [
    { name: "06:59 => 非工作时段", passed: !isWithinActiveHours(at("06:59")) },
    { name: "07:00 => 工作时段", passed: isWithinActiveHours(at("07:00")) },
    { name: "22:29 => 工作时段", passed: isWithinActiveHours(at("22:29")) },
    { name: "22:30 => 非工作时段", passed: !isWithinActiveHours(at("22:30")) },
    { name: "10:24 => 非半点前提醒窗口", passed: !isWithinReminderWindow(at("10:24")) },
    { name: "10:25 => 半点前提醒窗口", passed: isWithinReminderWindow(at("10:25")) },
    { name: "10:29 => 半点前提醒窗口", passed: isWithinReminderWindow(at("10:29")) },
    { name: "10:30 => 不属于 reminderWindow", passed: !isWithinReminderWindow(at("10:30")) },
    { name: "10:30 => 属于 focusWindow", passed: isWithinFocusWindow(at("10:30")) },
    { name: "10:34 => 属于 focusWindow", passed: isWithinFocusWindow(at("10:34")) },
    { name: "10:36 => 不属于 focusWindow", passed: !isWithinFocusWindow(at("10:36")) },
    {
      name: "2026-05-17 10:00 => TOO_EARLY / LOW",
      passed: getBookingDatePhase(new Date("2026-05-17T10:00:00"), targetDate) === "TOO_EARLY"
        && getTaskPriority(new Date("2026-05-17T10:00:00"), targetDate) === "LOW"
    },
    {
      name: "2026-05-18 10:00 => MAIN_RELEASE_DAY / HIGH",
      passed: getBookingDatePhase(new Date("2026-05-18T10:00:00"), targetDate) === "MAIN_RELEASE_DAY"
        && getTaskPriority(new Date("2026-05-18T10:00:00"), targetDate) === "HIGH"
    },
    {
      name: "2026-05-19 10:00 => FINAL_CHANCE_BEFORE_1130 / HIGH",
      passed: getBookingDatePhase(new Date("2026-05-19T10:00:00"), targetDate) === "FINAL_CHANCE_BEFORE_1130"
        && getTaskPriority(new Date("2026-05-19T10:00:00"), targetDate) === "HIGH"
    },
    {
      name: "2026-05-19 11:26 => FINAL_CHANCE_WINDOW / CRITICAL",
      passed: getBookingDatePhase(new Date("2026-05-19T11:26:00"), targetDate) === "FINAL_CHANCE_WINDOW"
        && getTaskPriority(new Date("2026-05-19T11:26:00"), targetDate) === "CRITICAL"
    },
    {
      name: "2026-05-19 11:31 => EXPIRED / EXPIRED",
      passed: getBookingDatePhase(new Date("2026-05-19T11:31:00"), targetDate) === "EXPIRED"
        && getTaskPriority(new Date("2026-05-19T11:31:00"), targetDate) === "EXPIRED"
    },
    {
      name: "2026-05-20 09:00 => SAME_DAY / EXPIRED",
      passed: getBookingDatePhase(new Date("2026-05-20T09:00:00"), targetDate) === "SAME_DAY"
        && getTaskPriority(new Date("2026-05-20T09:00:00"), targetDate) === "EXPIRED"
    },
    {
      name: "2026-05-21 09:00 => EXPIRED / EXPIRED",
      passed: getBookingDatePhase(new Date("2026-05-21T09:00:00"), targetDate) === "EXPIRED"
        && getTaskPriority(new Date("2026-05-21T09:00:00"), targetDate) === "EXPIRED"
    }
  ];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSchedulerConfig(config: SchedulerConfig): Required<SchedulerConfig> {
  return {
    ...defaultSchedulerConfig,
    ...config
  };
}

function dateAtTime(base: Date, hour: number, minute: number): Date {
  const date = new Date(base);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function parseTargetDate(targetDate: Date | string): Date {
  if (targetDate instanceof Date) {
    return targetDate;
  }
  const [year, month, day] = targetDate.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function startOfLocalDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function differenceInCalendarDays(target: Date, now: Date): number {
  const targetStart = startOfLocalDay(target).getTime();
  const nowStart = startOfLocalDay(now).getTime();
  return Math.round((targetStart - nowStart) / 86_400_000);
}
