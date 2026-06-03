export type TimeWindow = {
  start: string;
  end: string;
};

export type CustomerInfo = {
  salutation: "先生" | "小姐" | "太太" | "女士";
  surname: string;
  givenName: string;
  countryCode: string;
  phone: string;
  email: string;
  documentType: string;
  accountType: string;
};

export type AppointmentPreferences = {
  preferredDistricts: string[];
  preferredBranches: string[];
  preferredDates: string[];
  preferredTimes: string[];
  selectionMode?: "date-first" | "branch-first";
  timeWindows: TimeWindow[];
  daysAhead: number;
};

export type RunnerConfig = {
  headless: boolean;
  releaseWindowRefreshIntervalMs: number;
  normalRefreshIntervalMs: number;
  releaseWindowBeforeMs: number;
  releaseWindowAfterMs: number;
  maxAttempts: number;
};

export type XianyuConfig = {
  rawConversation?: string;
};

export type BookingRequest = {
  customer: CustomerInfo;
  appointment: AppointmentPreferences;
  runner: RunnerConfig;
  xianyu?: XianyuConfig;
};

export type GenericTaskStatus =
  | "IDLE"
  | "SLEEPING"
  | "NORMAL_CHECK"
  | "NO_RESULT"
  | "USER_ACTION_REQUIRED"
  | "PREPARING"
  | "READY"
  | "REMINDER_WINDOW"
  | "PROCESSING"
  | "SUCCESS"
  | "NEEDS_REVIEW"
  | "FAILED";

export type BookingDatePhase =
  | "TOO_EARLY"
  | "MAIN_RELEASE_DAY"
  | "FINAL_CHANCE_BEFORE_1130"
  | "FINAL_CHANCE_WINDOW"
  | "EXPIRED"
  | "SAME_DAY";

export type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL" | "EXPIRED";

export type TaskStatus =
  | GenericTaskStatus
  | "idle"
  | "sleeping"
  | "normal-probe"
  | "no-slot-found"
  | "user-prepare-required"
  | "wait-captcha"
  | "prefill"
  | "ready"
  | "release-window"
  | "submitting"
  | "success"
  | "needs-manual"
  | "pending"
  | "running"
  | "preparing-first-page"
  | "normal-probing"
  | "probe-no-slot"
  | "slot-found"
  | "waiting-next-probe"
  | "waiting-release-warmup"
  | "waiting-human-verification"
  | "prefilling-after-captcha"
  | "prefilled-waiting-release"
  | "release-scanning"
  | "slot-locked"
  | "final-submitting"
  | "slot-full-scanning"
  | "continuing"
  | "completed"
  | "needs-human"
  | "failed";

export function normalizeTaskStatus(status: TaskStatus): GenericTaskStatus {
  if (isGenericTaskStatus(status)) {
    return status;
  }

  const mapping: Partial<Record<TaskStatus, GenericTaskStatus>> = {
    pending: "IDLE",
    running: "PROCESSING",
    completed: "SUCCESS",
    "needs-human": "NEEDS_REVIEW",
    failed: "FAILED",
    idle: "IDLE",
    sleeping: "SLEEPING",
    "normal-probe": "NORMAL_CHECK",
    "normal-probing": "NORMAL_CHECK",
    "probe-no-slot": "NO_RESULT",
    "no-slot-found": "NO_RESULT",
    "user-prepare-required": "USER_ACTION_REQUIRED",
    "waiting-human-verification": "USER_ACTION_REQUIRED",
    "wait-captcha": "USER_ACTION_REQUIRED",
    "preparing-first-page": "PREPARING",
    "prefilling-after-captcha": "PREPARING",
    prefill: "PREPARING",
    ready: "READY",
    "prefilled-waiting-release": "READY",
    "waiting-next-probe": "IDLE",
    "waiting-release-warmup": "REMINDER_WINDOW",
    "release-window": "REMINDER_WINDOW",
    "release-scanning": "PROCESSING",
    "slot-locked": "PROCESSING",
    "final-submitting": "PROCESSING",
    "slot-full-scanning": "PROCESSING",
    submitting: "PROCESSING",
    continuing: "PROCESSING",
    success: "SUCCESS",
    "needs-manual": "NEEDS_REVIEW"
  };

  return mapping[status] ?? "IDLE";
}

function isGenericTaskStatus(status: TaskStatus): status is GenericTaskStatus {
  return [
    "IDLE",
    "SLEEPING",
    "NORMAL_CHECK",
    "NO_RESULT",
    "USER_ACTION_REQUIRED",
    "PREPARING",
    "READY",
    "REMINDER_WINDOW",
    "PROCESSING",
    "SUCCESS",
    "NEEDS_REVIEW",
    "FAILED"
  ].includes(status);
}

export type AppointmentTask = {
  id: string;
  title: string;
  customer: CustomerInfo;
  appointment: AppointmentPreferences;
  runner: RunnerConfig;
  xianyu?: XianyuConfig;
  fee: number;
  currency: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  attempts: number;
  appointmentNumber?: string;
  referenceNumber?: string;
  appointmentDate?: string;
  appointmentTime?: string;
  district?: string;
  branch?: string;
  confirmationText?: string;
  bookedSlot?: Slot;
  resultJsonPath?: string;
  successScreenshotPath?: string;
  screenshotPath?: string;
  lastProbeAt?: string;
  lastProbeResult?: "有号" | "无号" | "异常";
  nextProbeAt?: string;
  inReleaseFocusWindow?: boolean;
  skippedTargetDate?: boolean;
  lastMessage?: string;
  logs?: TaskLogEntry[];
};

export type TaskLogEntry = {
  at: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
};

export type DashboardSummary = {
  totalTasks: number;
  pendingTasks: number;
  runningTasks: number;
  completedTasks: number;
  needsHumanTasks: number;
  failedTasks: number;
  completionRate: number;
  totalRevenue: number;
  completedRevenue: number;
  averageCompletionMs: number;
};

export type Slot = {
  branch: string;
  district?: string;
  date: string;
  time: string;
  rawLabel?: string;
};

export type BookingSuccessDetails = {
  referenceNumber: string;
  documentType?: string;
  accountType?: string;
  surname?: string;
  givenName?: string;
  countryCode?: string;
  phone?: string;
  email?: string;
  appointmentDate?: string;
  appointmentTime?: string;
  district?: string;
  branch?: string;
  confirmationText: string;
  successScreenshotPath?: string;
};

export type BookingResult =
  | {
      status: "booked";
      confirmationText: string;
      slot: Slot;
      referenceNumber: string;
      details: BookingSuccessDetails;
    }
  | {
      status: "no-slot";
      reason: string;
    }
  | {
      status: "needs-human";
      reason: string;
    };
