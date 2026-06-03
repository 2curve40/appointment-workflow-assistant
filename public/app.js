const form = document.querySelector("#taskForm");
const metrics = document.querySelector("#metrics");
const tasksEl = document.querySelector("#tasks");
const runnerState = document.querySelector("#runnerState");
const revenueChart = document.querySelector("#revenueChart");
const lastOrderNotice = document.querySelector("#lastOrderNotice");
const startRunner = document.querySelector("#startRunner");
const stopRunner = document.querySelector("#stopRunner");
const openDebugFolder = document.querySelector("#openDebugFolder");
const clearDebugFiles = document.querySelector("#clearDebugFiles");
const releaseCountdown = document.querySelector("#releaseCountdown");
const releaseClock = document.querySelector("#releaseClock");
const rhythmMode = document.querySelector("#rhythmMode");
const rhythmStatus = document.querySelector("#rhythmStatus");
const rhythmLastCheck = document.querySelector("#rhythmLastCheck");
const rhythmLastResult = document.querySelector("#rhythmLastResult");
const rhythmNextCheck = document.querySelector("#rhythmNextCheck");
const rhythmHalfHour = document.querySelector("#rhythmHalfHour");
const rhythmReminder = document.querySelector("#rhythmReminder");
const rhythmFocus = document.querySelector("#rhythmFocus");
const rhythmResume = document.querySelector("#rhythmResume");
const parseConversation = document.querySelector("#parseConversation");
const requiredNotice = document.querySelector("#requiredNotice");
const submitTask = document.querySelector("#submitTask");
const cancelEdit = document.querySelector("#cancelEdit");
const taskPreview = document.querySelector("#taskPreview");
const districtChoices = document.querySelector("#districtChoices");
const timeChoices = document.querySelector("#timeChoices");
const dateChoices = document.querySelector("#dateChoices");
const calendarHeader = document.querySelector("#calendarHeader");
const taskDetails = document.querySelector("#taskDetails");

const districtOptions = [
  "中西區",
  "東區",
  "離島區",
  "九龍城區",
  "葵青區",
  "觀塘區",
  "北區",
  "西貢區",
  "沙田區",
  "深水埗區",
  "南區",
  "大埔區",
  "荃灣區",
  "屯門區",
  "灣仔區",
  "黃大仙區",
  "油尖旺區",
  "元朗區"
];

const timeOptions = ["09:00", "09:45", "10:30", "11:15", "14:00", "14:45", "15:30", "16:15"];

const districtAliases = {
  中西: "中西區",
  中环: "中西區",
  中環: "中西區",
  上环: "中西區",
  上環: "中西區",
  东区: "東區",
  東區: "東區",
  离岛: "離島區",
  離島: "離島區",
  九龙城: "九龍城區",
  九龍城: "九龍城區",
  葵青: "葵青區",
  观塘: "觀塘區",
  觀塘: "觀塘區",
  北区: "北區",
  北區: "北區",
  西贡: "西貢區",
  西貢: "西貢區",
  沙田: "沙田區",
  深水埗: "深水埗區",
  南区: "南區",
  南區: "南區",
  大埔: "大埔區",
  荃湾: "荃灣區",
  荃灣: "荃灣區",
  屯门: "屯門區",
  屯門: "屯門區",
  湾仔: "灣仔區",
  灣仔: "灣仔區",
  黄大仙: "黃大仙區",
  黃大仙: "黃大仙區",
  油尖旺: "油尖旺區",
  尖沙咀: "油尖旺區",
  旺角: "油尖旺區",
  油麻地: "油尖旺區",
  元朗: "元朗區"
};

const requiredFields = [
  ["title", "任务名称"],
  ["surname", "姓氏"],
  ["givenName", "名字"],
  ["phone", "流動電話號碼"],
  ["email", "電郵地址"]
];

let latestTasks = [];
let editingTaskId = null;
let recordingTaskId = null;
let latestRunner = null;
const openLogTaskIds = new Set();
const openArchivedTaskIds = new Set();
let calendarViewYear = null;
let calendarViewMonth = null;

const statusText = {
  IDLE: "IDLE",
  SLEEPING: "SLEEPING",
  NORMAL_CHECK: "NORMAL_CHECK",
  NO_RESULT: "NO_RESULT",
  USER_ACTION_REQUIRED: "USER_ACTION_REQUIRED",
  PREPARING: "PREPARING",
  READY: "READY",
  REMINDER_WINDOW: "REMINDER_WINDOW",
  PROCESSING: "PROCESSING",
  SUCCESS: "SUCCESS",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  FAILED: "FAILED",
  pending: "等待中",
  running: "预约中",
  "preparing-first-page": "准备第一页",
  "waiting-human-verification": "等待人工验证码",
  "prefilling-after-captcha": "验证码后预填资料",
  "prefilled-waiting-release": "已预填等待放号",
  "release-scanning": "高频扫描号源",
  "slot-locked": "已锁定号源",
  "final-submitting": "最终提交中",
  "slot-full-scanning": "号源已满继续扫描",
  continuing: "继续执行",
  completed: "已完成",
  "needs-human": "需人工",
  failed: "失败"
};

const normalizedStatusText = {
  IDLE: "IDLE",
  SLEEPING: "SLEEPING",
  NORMAL_CHECK: "NORMAL_CHECK",
  NO_RESULT: "NO_RESULT",
  USER_ACTION_REQUIRED: "USER_ACTION_REQUIRED",
  PREPARING: "PREPARING",
  READY: "READY",
  REMINDER_WINDOW: "REMINDER_WINDOW",
  PROCESSING: "PROCESSING",
  SUCCESS: "SUCCESS",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  FAILED: "FAILED"
};

const activeStatuses = new Set([
  "running",
  "preparing-first-page",
  "waiting-human-verification",
  "prefilling-after-captcha",
  "prefilled-waiting-release",
  "release-scanning",
  "slot-locked",
  "final-submitting",
  "slot-full-scanning",
  "continuing"
]);

const genericStatuses = new Set(Object.keys(normalizedStatusText));
const normalizedStatusMap = {
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

let nextNormalCheckPreview = new Date(Date.now() + 12 * 60 * 1000);

async function fetchState() {
  if (window.location.protocol === "file:") {
    return {
      tasks: [],
      summary: {
        totalTasks: 0,
        completedTasks: 0,
        completionRate: 0,
        totalRevenue: 0,
        averageCompletionMs: 0
      },
      runner: { running: false }
    };
  }
  const response = await fetch("/api/tasks");
  if (!response.ok) throw new Error("加载任务失败");
  return response.json();
}

function renderChoiceGroup(container, name, values, selectedValues = []) {
  const selected = new Set(selectedValues);
  container.innerHTML = `
    <div class="choiceGroupControls">
      <button class="choiceSelectAll" type="button" data-select-all="${name}">全选</button>
    </div>
    ${values.map((value) => `
    <label class="checkOption">
      <input type="checkbox" name="${name}" value="${escapeHtml(value)}" ${selected.has(value) ? "checked" : ""}>
      <span>${escapeHtml(value)}</span>
    </label>
  `).join("")}
  `;
}

function setCheckedValues(name, values) {
  const selected = new Set(values);
  form.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
    input.checked = selected.has(input.value);
  });
}

function renderDateCalendar(selectedValues = []) {
  const today = startOfDay(new Date());
  const firstBookable = addDays(today, 1);
  const lastBookable = new Date(today.getFullYear(), today.getMonth() + 3, today.getDate());
  const firstBookableMonthStart = new Date(firstBookable.getFullYear(), firstBookable.getMonth(), 1);
  const lastBookableMonthStart = new Date(lastBookable.getFullYear(), lastBookable.getMonth(), 1);
  const selectedDates = selectedValues
    .map((value) => parseIsoDate(value))
    .filter((value) => value instanceof Date);

  if (selectedDates.length > 0) {
    const firstSelected = selectedDates.sort((a, b) => a.getTime() - b.getTime())[0];
    calendarViewYear = firstSelected.getFullYear();
    calendarViewMonth = firstSelected.getMonth();
  } else if (calendarViewYear === null || calendarViewMonth === null) {
    calendarViewYear = firstBookable.getFullYear();
    calendarViewMonth = firstBookable.getMonth();
  }

  const viewMonthStart = new Date(calendarViewYear, calendarViewMonth, 1);
  if (viewMonthStart < firstBookableMonthStart) {
    calendarViewYear = firstBookable.getFullYear();
    calendarViewMonth = firstBookable.getMonth();
  }
  if (viewMonthStart > lastBookableMonthStart) {
    calendarViewYear = lastBookable.getFullYear();
    calendarViewMonth = lastBookable.getMonth();
  }

  const monthStart = new Date(calendarViewYear, calendarViewMonth, 1);
  const monthEnd = new Date(calendarViewYear, calendarViewMonth + 1, 0);
  const selected = new Set(selectedValues);
  const parts = [];
  const canGoPrev = monthStart > firstBookableMonthStart;
  const canGoNext = monthStart < lastBookableMonthStart;

  calendarHeader.innerHTML = `
    <button type="button" class="calendarNavButton" data-calendar-nav="prev" ${canGoPrev ? "" : "disabled"}>上个月</button>
    <span class="calendarHeaderLabel">${monthStart.getFullYear()}年 ${monthStart.getMonth() + 1}月</span>
    <button type="button" class="calendarNavButton" data-calendar-nav="next" ${canGoNext ? "" : "disabled"}>下个月</button>
  `;

  for (let index = 0; index < monthStart.getDay(); index += 1) {
    parts.push(`<div class="dateSpacer"></div>`);
  }

  for (let day = 1; day <= monthEnd.getDate(); day += 1) {
    const date = new Date(monthStart.getFullYear(), monthStart.getMonth(), day);
    const iso = toIsoDate(date);
    const disabled = date < firstBookable || date > lastBookable;
    parts.push(`
      <label class="dateOption">
        <input type="checkbox" name="preferredDates" value="${iso}" ${selected.has(iso) ? "checked" : ""} ${disabled ? "disabled" : ""}>
        <span>${day}</span>
      </label>
    `);
  }

  dateChoices.innerHTML = parts.join("");
}

function resetTaskForm() {
  editingTaskId = null;
  form.reset();
  form.fee.value = "20";
  form.documentType.value = "中國居民身份證";
  form.selectionMode.value = "date-first";
  renderChoiceGroup(districtChoices, "districts", districtOptions);
  renderDateCalendar();
  renderChoiceGroup(timeChoices, "preferredTimes", timeOptions);
  submitTask.textContent = "新增任务";
  taskDetails.open = false;
  cancelEdit.hidden = true;
  updateRequiredNotice();
}

function fillFormFromTask(task) {
  editingTaskId = task.id;
  form.rawConversation.value = task.xianyu?.rawConversation || "";
  form.title.value = task.title || "";
  form.documentType.value = task.customer.documentType || "中國居民身份證";
  form.accountType.value = task.customer.accountType || "一般賬戶";
  form.salutation.value = task.customer.salutation || "先生";
  form.fee.value = String(task.fee ?? 20);
  form.surname.value = task.customer.surname || "";
  form.givenName.value = task.customer.givenName || "";
  form.countryCode.value = task.customer.countryCode || "852 香港";
  form.phone.value = task.customer.phone || "";
  form.email.value = task.customer.email || "";
  form.branches.value = task.appointment.preferredBranches?.join(", ") || "";
  form.selectionMode.value = task.appointment.selectionMode || "date-first";
  setCheckedValues("districts", task.appointment.preferredDistricts || []);
  renderDateCalendar(task.appointment.preferredDates || []);
  setCheckedValues("preferredTimes", task.appointment.preferredTimes || []);
  submitTask.textContent = "保存修改";
  taskDetails.open = true;
  cancelEdit.hidden = false;
  updateRequiredNotice();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return new Date(year, month - 1, day);
}

function splitList(value) {
  return value
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function selectedValues(name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}

function buildTaskPayload() {
  const data = new FormData(form);
  return {
    title: data.get("title"),
    customer: {
      salutation: data.get("salutation"),
      surname: data.get("surname"),
      givenName: data.get("givenName"),
      countryCode: data.get("countryCode"),
      phone: data.get("phone"),
      email: data.get("email"),
      documentType: data.get("documentType"),
      accountType: data.get("accountType")
    },
    appointment: {
      preferredDistricts: selectedValues("districts"),
      preferredBranches: splitList(String(data.get("branches") || "")),
      preferredDates: selectedValues("preferredDates"),
      preferredTimes: selectedValues("preferredTimes"),
      selectionMode: data.get("selectionMode") || "date-first",
      timeWindows: [{ start: "09:00", end: "17:00" }],
      daysAhead: 7
    },
    runner: {
      headless: false,
      releaseWindowRefreshIntervalMs: 1500,
      normalRefreshIntervalMs: 15 * 60 * 1000,
      releaseWindowBeforeMs: 10000,
      releaseWindowAfterMs: 120000,
      maxAttempts: 0
    },
    fee: Number(data.get("fee") || 0),
    currency: "HKD",
    xianyu: {
      rawConversation: data.get("rawConversation") || undefined
    }
  };
}

function displayValue(value) {
  if (Array.isArray(value)) return value.length > 0 ? value.join("、") : "--";
  const text = String(value || "").trim();
  return text || "--";
}

function selectionModeLabel(value) {
  return value === "branch-first" ? "先選定分行" : "先選定預約日期和時間";
}

function taskConfirmationRows(payload) {
  const customer = payload.customer;
  const appointment = payload.appointment;
  return [
    ["任务名称", payload.title],
    ["证件种类", customer.documentType],
    ["开户种类", customer.accountType],
    ["称谓", customer.salutation],
    ["姓名", `${customer.surname || ""}${customer.givenName || ""}`],
    ["国家/区域编号", customer.countryCode],
    ["流动电话号码", customer.phone],
    ["电邮地址", customer.email],
    ["区域偏好", appointment.preferredDistricts],
    ["分行偏好", appointment.preferredBranches],
    ["第二页选择方式", selectionModeLabel(appointment.selectionMode)],
    ["预约日期", appointment.preferredDates],
    ["可接受时段", appointment.preferredTimes],
    ["收入", `${payload.currency} ${payload.fee || 0}`],
    ["闲鱼对话", payload.xianyu.rawConversation]
  ];
}

function buildTaskConfirmationMessage(payload) {
  const title = editingTaskId ? "确认保存以下任务信息？" : "确认添加以下任务信息？";
  const rows = taskConfirmationRows(payload)
    .map(([label, value]) => `${label}：${displayValue(value)}`)
    .join("\n");
  return `${title}\n\n${rows}`;
}

function updateTaskPreview() {
  if (!taskPreview) return;
  const payload = buildTaskPayload();
  const rows = taskConfirmationRows(payload);
  taskPreview.innerHTML = `
    <div class="taskPreviewHeader">
      <h3>网页填表信息确认</h3>
      <span>${editingTaskId ? "修改前请核对" : "添加前请核对"}</span>
    </div>
    <dl>
      ${rows
        .map(([label, value]) => `
          <div>
            <dt>${escapeHtml(label)}</dt>
            <dd>${escapeHtml(displayValue(value))}</dd>
          </div>
        `)
        .join("")}
    </dl>
  `;
}

function parseConversationText(raw) {
  const parsedInfo = extractXianyuBookingInfo(raw);
  const text = raw.replace(/\s+/g, " ").trim();
  const phone = parsedInfo.phone;
  const email = parsedInfo.email;
  const fee = text.match(/(?:收入|价格|價錢|价钱|收|赚|賺|佣金|費用|费用|HKD|港幣|港币|\$)\D{0,6}(\d{2,6})/)?.[1];
  const title = text.slice(0, 24) || undefined;
  const salutation = inferSalutation(text);
  const countryCode = inferCountryCode(text, phone);
  const districts = Object.entries(districtAliases)
    .filter(([keyword]) => text.includes(keyword))
    .map(([, district]) => district);
  const locationDistricts = Object.entries(districtAliases)
    .filter(([keyword]) => parsedInfo.location.includes(keyword))
    .map(([, district]) => district);
  const times = parsedInfo.appointmentTime ? timesFromParsedTime(parsedInfo.appointmentTime) : inferTimes(text);
  const dates = parsedInfo.appointmentDate ? [parsedInfo.appointmentDate] : inferDates(text);

  return {
    title,
    salutation,
    surname: parsedInfo.surname,
    givenName: parsedInfo.givenName,
    phone,
    email,
    fee,
    countryCode,
    districts: [...new Set([...districts, ...locationDistricts])],
    times,
    dates
  };
}

function extractXianyuBookingInfo(rawText, options = {}) {
  const text = String(rawText || "").replace(/\r/g, "\n");
  const compact = text.replace(/\s+/g, " ").trim();
  const currentYear = Number(options.currentYear || new Date().getFullYear());

  const result = {
    surname: "",
    givenName: "",
    phone: "",
    email: "",
    appointmentDate: "",
    appointmentTime: "",
    location: "",
    missingFields: [],
    confidence: {
      surname: 0,
      givenName: 0,
      phone: 0,
      appointmentDate: 0,
      appointmentTime: 0,
      email: 0,
      location: 0
    }
  };

  const phoneMatch = compact.match(/(?:\+?86[-\s]?)?(1[3-9]\d[\s-]?\d{4}[\s-]?\d{4})|(?:\+?852[-\s]?)?([569]\d{3}[\s-]?\d{4})/);
  if (phoneMatch) {
    result.phone = (phoneMatch[1] || phoneMatch[2]).replace(/\D/g, "");
    result.confidence.phone = 0.98;
  }

  const emailMatch = compact.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch) {
    result.email = emailMatch[0];
    result.confidence.email = 0.98;
  }

  const name = extractChineseName(text);
  if (name) {
    result.surname = name.slice(0, 1);
    result.givenName = name.slice(1);
    result.confidence.surname = 0.86;
    result.confidence.givenName = 0.86;
  }

  const date = extractConversationDate(compact, currentYear);
  if (date) {
    result.appointmentDate = date;
    result.confidence.appointmentDate = 0.9;
  }

  const time = extractConversationTime(compact);
  if (time) {
    result.appointmentTime = time;
    result.confidence.appointmentTime = 0.88;
  }

  const location = extractConversationLocation(text);
  if (location) {
    result.location = location;
    result.confidence.location = 0.72;
  }

  for (const field of ["surname", "givenName", "phone", "email", "appointmentDate", "appointmentTime", "location"]) {
    if (!result[field]) result.missingFields.push(field);
  }

  return result;
}

function extractChineseName(text) {
  const commonSurnames = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘斜厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍邱";
  const blacklist = new Set(["香港居民", "中国居民", "中國居民", "时间合适", "時間合適", "福田口岸"]);
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const cleaned = line.replace(/[^\u4e00-\u9fa5]/g, "");
    if (/^[\u4e00-\u9fa5]{2,3}$/.test(cleaned) && !blacklist.has(cleaned) && commonSurnames.includes(cleaned[0])) {
      return cleaned;
    }
  }

  const labeled = text.match(/(?:姓名|名字|客户|客戶|客人|戶名|户名|叫)[:：\s是为為叫]*([\u4e00-\u9fa5]{2,3})/);
  if (labeled && commonSurnames.includes(labeled[1][0]) && !blacklist.has(labeled[1])) {
    return labeled[1];
  }

  return "";
}

function extractConversationDate(text, currentYear) {
  const full = text.match(/\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\b/);
  if (full) return formatConversationDate(Number(full[1]), Number(full[2]), Number(full[3]));

  const short = text.match(/(?:^|[^\d])(\d{1,2})[./月-](\d{1,2})日?(?:$|[^\d])/);
  if (short) return formatConversationDate(currentYear, Number(short[1]), Number(short[2]));

  return "";
}

function formatConversationDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function extractConversationTime(text) {
  const rangeWithMinutes = text.match(/(?:^|[^\d])(\d{1,2})[:：](\d{2})\s*[-~—至到]\s*(\d{1,2})[:：](\d{2})(?:$|[^\d])/);
  if (rangeWithMinutes) {
    return `${toConversationTime(rangeWithMinutes[1], rangeWithMinutes[2])}-${toConversationTime(rangeWithMinutes[3], rangeWithMinutes[4])}`;
  }

  const singleWithMinutes = text.match(/(?:^|[^\d])(\d{1,2})[:：](\d{2})(?:$|[^\d])/);
  if (singleWithMinutes) {
    return toConversationTime(singleWithMinutes[1], singleWithMinutes[2]);
  }

  const rangeHours = text.match(/(?:^|[^\d])(\d{1,2})\s*[-~—至到]\s*(\d{1,2})\s*(?:点|點|時|时)(?:$|[^\d])/);
  if (rangeHours) {
    return `${toConversationTime(rangeHours[1], "00")}-${toConversationTime(rangeHours[2], "00")}`;
  }

  const singleHour = text.match(/(?:^|[^\d])(\d{1,2})\s*(?:点|點|時|时)(?:$|[^\d])/);
  if (singleHour) {
    return toConversationTime(singleHour[1], "00");
  }

  return "";
}

function toConversationTime(hour, minute) {
  const h = Number(hour);
  const m = Number(minute);
  if (h < 0 || h > 23 || m < 0 || m > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timesFromParsedTime(value) {
  if (!value) return [];
  if (!value.includes("-")) return timeOptions.includes(value) ? [value] : [];

  const [start, end] = value.split("-");
  const startMinutes = minutesOfDay(start);
  const endMinutes = minutesOfDay(end);
  if (startMinutes === undefined || endMinutes === undefined || endMinutes <= startMinutes) return [];
  return timeOptions.filter((time) => {
    const minutes = minutesOfDay(time);
    return minutes !== undefined && minutes >= startMinutes && minutes < endMinutes;
  });
}

function minutesOfDay(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

function extractConversationLocation(text) {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const locationKeywords = /(中环|中環|尖沙咀|旺角|铜锣湾|銅鑼灣|湾仔|灣仔|沙田|荃湾|荃灣|元朗|屯门|屯門|观塘|觀塘|分行|支行|网点|網點|地址|Location|location|口岸)/;

  for (const line of lines) {
    if (locationKeywords.test(line)) {
      return line
        .replace(/[，,]*\s*时间合适的?\s*$/g, "")
        .replace(/^\d{1,2}[./月-]\d{1,2}日?\s*/g, "")
        .replace(/\d{1,2}\s*[-~—至到]\s*\d{1,2}\s*(点|點|時|时)?/g, "")
        .replace(/\d{1,2}[:：]\d{2}(\s*[-~—至到]\s*\d{1,2}[:：]\d{2})?/g, "")
        .trim()
        .replace(/^[，,、\s]+|[，,、\s]+$/g, "");
    }
  }

  return "";
}

function inferCountryCode(text, phone) {
  if (/86|中國內地|中国内地|內地|内地/.test(text) || /^1[3-9]\d{9}$/.test(phone || "")) return "86 中國內地";
  if (/853|澳門|澳门/.test(text)) return "853 澳門";
  if (/886|台灣|台湾/.test(text)) return "886 台灣";
  if (/65|新加坡/.test(text)) return "65 新加坡";
  return "852 香港";
}

function inferSalutation(text) {
  const explicit = text.match(/先生|小姐|太太|女士/)?.[0];
  if (explicit) return explicit;
  if (/(?:^|[\s，,。；;:：])女(?:性|士)?(?:$|[\s，,。；;:：])/.test(text)) return "女士";
  if (/(?:^|[\s，,。；;:：])男(?:性|士)?(?:$|[\s，,。；;:：])/.test(text)) return "先生";
  return undefined;
}

function inferTimes(text) {
  const found = new Set();
  for (const time of timeOptions) {
    const loose = time.replace(":00", "点").replace(":45", "点45").replace(":30", "点半").replace(":15", "点15");
    if (text.includes(time) || text.includes(loose)) found.add(time);
  }
  if (/上午|早上|中午前/.test(text)) {
    ["09:00", "09:45", "10:30", "11:15"].forEach((time) => found.add(time));
  }
  if (/下午|午後|午后|14|2点|兩點|两点|三点|3点|四点|4点/.test(text)) {
    ["14:00", "14:45", "15:30", "16:15"].forEach((time) => found.add(time));
  }
  return [...found];
}

function inferDates(text) {
  const today = startOfDay(new Date());
  const found = new Set();
  if (/今天|今日/.test(text)) found.add(toIsoDate(today));
  if (/明天|聽日|听日/.test(text)) found.add(toIsoDate(addDays(today, 1)));
  if (/后天|後天/.test(text)) found.add(toIsoDate(addDays(today, 2)));

  for (const match of text.matchAll(/(?:5月)?(\d{1,2})[日号號]/g)) {
    const day = Number(match[1]);
    const date = new Date(today.getFullYear(), today.getMonth(), day);
    if (date >= today && date <= addDays(today, 7)) found.add(toIsoDate(date));
  }
  return [...found];
}

function inferName(text) {
  const explicit = text.match(/(?:姓名|名字|客户|客戶|叫|姓氏?名?)\s*[:：是为為叫]?\s*([\u4e00-\u9fa5]{2,4}|[A-Z][A-Z\s]{2,30})/i)?.[1]
    ?? text.match(/([\u4e00-\u9fa5]{2,4})(?:先生|小姐|太太|女士)/)?.[1];
  if (!explicit) return undefined;
  const cleaned = explicit.trim();
  if (/^[A-Z\s]+$/i.test(cleaned)) {
    const parts = cleaned.split(/\s+/);
    return { surname: parts[0] || "", givenName: parts.slice(1).join(" ") || "" };
  }
  return { surname: cleaned.slice(0, 1), givenName: cleaned.slice(1) };
}

function applyParsedConversation() {
  const raw = String(form.rawConversation.value || "");
  if (raw.trim()) {
    taskDetails.open = true;
  }
  const parsed = parseConversationText(raw);
  if (parsed.title && !form.title.value) form.title.value = parsed.title;
  if (parsed.salutation) form.salutation.value = parsed.salutation;
  if (parsed.surname && !form.surname.value) form.surname.value = parsed.surname;
  if (parsed.givenName && !form.givenName.value) form.givenName.value = parsed.givenName;
  if (parsed.phone) form.phone.value = parsed.phone.replace(/^\+?852/, "");
  if (parsed.email) form.email.value = parsed.email;
  if (parsed.fee) form.fee.value = parsed.fee;
  if (parsed.countryCode) form.countryCode.value = parsed.countryCode;
  if (parsed.districts.length > 0) setCheckedValues("districts", parsed.districts);
  if (parsed.times.length > 0) setCheckedValues("preferredTimes", parsed.times);
  if (parsed.dates.length > 0) setCheckedValues("preferredDates", parsed.dates);
  updateRequiredNotice();
}

function validateTaskForm() {
  const missing = requiredFields
    .filter(([name]) => !String(form.elements[name].value || "").trim())
    .map(([, label]) => label);
  if (selectedValues("districts").length === 0) missing.push("區域偏好");
  if (selectedValues("preferredDates").length === 0) missing.push("預約日期");
  if (selectedValues("preferredTimes").length === 0) missing.push("可接受時段");
  return missing;
}

function updateRequiredNotice() {
  updateTaskPreview();
  form.querySelectorAll(".fieldError").forEach((element) => element.classList.remove("fieldError"));
  const missing = validateTaskForm();
  if (missing.length === 0) {
    requiredNotice.textContent = editingTaskId ? "必填内容已齐，可以保存修改" : "必填内容已齐，可以添加任务";
    requiredNotice.classList.remove("warn");
    return true;
  }
  requiredNotice.textContent = `还缺：${missing.join("、")}`;
  requiredNotice.classList.add("warn");
  for (const [name] of requiredFields) {
    if (!String(form.elements[name].value || "").trim()) {
      form.elements[name].classList.add("fieldError");
    }
  }
  return false;
}

function formatMoney(value) {
  return `¥${Math.round(Number(value || 0)).toLocaleString("zh-CN")}`;
}

function formatDuration(ms) {
  if (!ms) return "-";
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours > 0) return `${hours}小时${rest}分钟`;
  return `${Math.max(1, rest)}分钟`;
}

function taskProgress(task, runner) {
  const normalized = normalizeDashboardStatus(task.status);
  if (normalized === "SUCCESS") return 100;
  if (normalized === "FAILED") return 100;
  if (normalized === "IDLE") return 0;
  if (normalized === "SLEEPING") return 0;
  if (normalized === "NORMAL_CHECK") return 20;
  if (normalized === "NO_RESULT") return 24;
  if (normalized === "USER_ACTION_REQUIRED") return 32;
  if (normalized === "PREPARING") return 44;
  if (normalized === "READY") return 58;
  if (normalized === "REMINDER_WINDOW") return 64;
  if (normalized === "PROCESSING") return 76;
  if (normalized === "NEEDS_REVIEW") return 72;
  if (task.status === "completed") return 100;
  if (task.status === "preparing-first-page") return 18;
  if (task.status === "waiting-human-verification") return 30;
  if (task.status === "prefilling-after-captcha") return 46;
  if (task.status === "prefilled-waiting-release") return 58;
  if (task.status === "release-scanning") return 70;
  if (task.status === "slot-locked") return 82;
  if (task.status === "final-submitting") return 92;
  if (task.status === "slot-full-scanning") return 74;
  if (task.status === "continuing") return 76;
  if (task.status === "needs-human") return 72;
  if (task.status === "failed") return 100;
  if (task.status === "running" || runner?.activeTaskId === task.id) {
    return Math.min(88, 18 + Math.max(0, task.attempts || 0) * 8);
  }
  return 0;
}

function percent(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

function nextHalfHourCountdown() {
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  if (next.getMinutes() < 30) {
    next.setMinutes(30);
  } else {
    next.setHours(next.getHours() + 1, 0);
  }
  const totalSeconds = Math.max(0, Math.ceil((next - now) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function renderReleaseCountdown() {
  const now = new Date();
  if (releaseCountdown) {
    releaseCountdown.textContent = `距下个半点 ${nextHalfHourCountdown()}`;
  }
  if (releaseClock) {
    releaseClock.querySelector("strong").textContent = formatPreciseClock(now);
  }
  document.body.classList.toggle("releaseAttention", isOneMinuteBeforeHalfHour(now));
}

function formatPreciseClock(date) {
  return [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join(":");
}

function isOneMinuteBeforeHalfHour(date = new Date()) {
  return date.getMinutes() === 29;
}

function normalizeDashboardStatus(status) {
  if (genericStatuses.has(status)) return status;
  return normalizedStatusMap[status] || "IDLE";
}

function isWithinActiveHours(date = new Date()) {
  const start = new Date(date);
  start.setHours(7, 0, 0, 0);
  const end = new Date(date);
  end.setHours(22, 30, 0, 0);
  return date >= start && date < end;
}

function nextActiveStart(date = new Date()) {
  const start = new Date(date);
  start.setHours(7, 0, 0, 0);
  if (date < start) return start;
  start.setDate(start.getDate() + 1);
  return start;
}

function nextHalfHour(date = new Date()) {
  const next = new Date(date);
  next.setSeconds(0, 0);
  if (next.getMinutes() < 30) {
    next.setMinutes(30);
  } else {
    next.setHours(next.getHours() + 1, 0);
  }
  return next;
}

function isReminderWindow(date = new Date()) {
  const halfHour = nextHalfHour(date);
  return date >= new Date(halfHour.getTime() - 5 * 60 * 1000) && date < halfHour;
}

function isFocusWindow(date = new Date()) {
  const halfHour = nextHalfHour(date);
  const previousHalfHour = new Date(halfHour.getTime() - 30 * 60 * 1000);
  const inWindow = (center) => date >= new Date(center.getTime() - 5 * 60 * 1000)
    && date <= new Date(center.getTime() + 5 * 60 * 1000);
  return inWindow(halfHour) || inWindow(previousHalfHour);
}

function formatClock(value) {
  if (!value) return "--";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function renderRhythmCard(tasks) {
  const now = new Date();
  const activeTask = tasks.find((task) => activeStatuses.has(task.status)) || tasks[0];
  const normalized = normalizeDashboardStatus(activeTask?.status || (isWithinActiveHours(now) ? "IDLE" : "SLEEPING"));
  const activeMode = isWithinActiveHours(now) ? "工作时段" : "休息时段";
  const nextCheck = activeTask?.nextProbeAt ? new Date(activeTask.nextProbeAt) : nextNormalCheckPreview;
  if (nextNormalCheckPreview < now) {
    nextNormalCheckPreview = new Date(now.getTime() + 12 * 60 * 1000);
  }

  rhythmMode.textContent = activeMode;
  rhythmMode.className = `pill ${activeMode === "工作时段" ? "status-running" : "status-needs-human"}`;
  rhythmStatus.textContent = normalizedStatusText[normalized] || normalized;
  rhythmLastCheck.textContent = formatClock(activeTask?.lastProbeAt);
  rhythmLastResult.textContent = activeTask?.lastProbeResult || "--";
  rhythmNextCheck.textContent = formatClock(nextCheck);
  rhythmHalfHour.textContent = nextHalfHourCountdown();
  rhythmReminder.textContent = isReminderWindow(now) ? "是" : "否";
  rhythmFocus.textContent = isFocusWindow(now) ? "是" : "否";
  rhythmResume.textContent = isWithinActiveHours(now) ? "--" : formatClock(nextActiveStart(now));
}

function taskTargetDate(task) {
  return [...(task.appointment.preferredDates || [])].filter(Boolean).sort()[0];
}

function isExpiredTask(task) {
  const targetDate = taskTargetDate(task);
  if (!targetDate) return false;
  return new Date(`${targetDate}T00:00:00`) < startOfDay(new Date());
}

function bookingDatePhase(now, targetDate) {
  if (!targetDate) return "未设置";
  const target = parseIsoDate(targetDate);
  const dayDiff = Math.round((startOfDay(target) - startOfDay(now)) / 86400000);
  if (dayDiff > 2) return "TOO_EARLY";
  if (dayDiff === 2) return "MAIN_RELEASE_DAY";
  if (dayDiff === 1) {
    const finalChance = finalChanceAt(targetDate);
    const finalWindowStart = new Date(finalChance.getTime() - 5 * 60 * 1000);
    if (now > finalChance) return "EXPIRED";
    if (now >= finalWindowStart && now <= finalChance) return "FINAL_CHANCE_WINDOW";
    return "FINAL_CHANCE_BEFORE_1130";
  }
  if (dayDiff === 0) return "SAME_DAY";
  return "EXPIRED";
}

function taskPriority(now, targetDate) {
  const phase = bookingDatePhase(now, targetDate);
  if (phase === "TOO_EARLY") return "LOW";
  if (phase === "MAIN_RELEASE_DAY" || phase === "FINAL_CHANCE_BEFORE_1130") return "HIGH";
  if (phase === "FINAL_CHANCE_WINDOW") return "CRITICAL";
  if (phase === "EXPIRED" || phase === "SAME_DAY") return "EXPIRED";
  return "NORMAL";
}

function finalChanceAt(targetDate) {
  const finalChance = parseIsoDate(targetDate);
  finalChance.setDate(finalChance.getDate() - 1);
  finalChance.setHours(11, 30, 0, 0);
  return finalChance;
}

function formatDistance(ms) {
  if (ms <= 0) return "已过";
  const totalMinutes = Math.ceil(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  return `${minutes}分钟`;
}

function renderMetrics(summary) {
  const totalTasks = latestTasks.length || summary.totalTasks || 0;
  const successfulTasks = latestTasks.filter(isTaskSuccessful);
  const completedCount = successfulTasks.length;
  const completedRevenue = successfulTasks.reduce((total, task) => total + Number(task.fee || 0), 0);
  const expectedRevenue = latestTasks.reduce((total, task) => total + Number(task.fee || 0), 0);
  const waitingCount = latestTasks.filter(isWaitingForActiveCaptcha).length;
  const runningCount = latestTasks.filter((task) => isTaskActivelyRunning(task) && !isWaitingForActiveCaptcha(task)).length;
  const reviewCount = latestTasks.filter((task) => ["needs-human", "failed"].includes(task.status) || ["NEEDS_REVIEW", "FAILED"].includes(normalizeDashboardStatus(task.status))).length;
  const items = [
    ["总任务", `${completedCount}/${totalTasks}`],
    ["总收入", `${formatMoney(completedRevenue)}/${formatMoney(expectedRevenue)}`],
    ["等待人工", waitingCount],
    ["运行中", runningCount],
    ["需处理", reviewCount]
  ];

  metrics.innerHTML = items
    .map(([label, value]) => `<article class="metric"><strong>${value}</strong><span>${label}</span></article>`)
    .join("");
}

function getDaysSinceLastOrder(tasks) {
  const completed = tasks
    .filter((task) => isTaskSuccessful(task) && task.completedAt)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  if (completed.length === 0) return undefined;
  const last = startOfDay(new Date(completed[0].completedAt));
  const today = startOfDay(new Date());
  return Math.max(0, Math.floor((today - last) / 86400000));
}

function isTaskSuccessful(task) {
  const normalized = normalizeDashboardStatus(task.status);
  return normalized === "SUCCESS" || task.status === "completed" || task.status === "SUCCESS";
}

function renderRevenueTrend(tasks) {
  const context = revenueChart.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = revenueChart.clientWidth || 800;
  const height = 140;
  revenueChart.width = width * ratio;
  revenueChart.height = height * ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const today = startOfDay(new Date());
  const days = Array.from({ length: 14 }, (_, index) => addDays(today, index - 13));
  const values = days.map((date) => {
    const iso = toIsoDate(date);
    return tasks
      .filter((task) => isTaskSuccessful(task) && task.completedAt?.startsWith(iso))
      .reduce((total, task) => total + Number(task.fee || 0), 0);
  });
  const max = Math.max(20, ...values);
  const padding = { top: 12, right: 10, bottom: 28, left: 36 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const step = chartWidth / days.length;
  const barWidth = Math.max(4, step - 5);

  context.strokeStyle = "#d8dee8";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(padding.left, padding.top);
  context.lineTo(padding.left, padding.top + chartHeight);
  context.lineTo(width - padding.right, padding.top + chartHeight);
  context.stroke();

  values.forEach((value, index) => {
    const x = padding.left + index * step + 3;
    const barHeight = (value / max) * chartHeight;
    const y = padding.top + chartHeight - barHeight;
    context.fillStyle = value > 0 ? "#0b6b57" : "#d8dee8";
    context.fillRect(x, y, barWidth, Math.max(value > 0 ? 3 : 1, barHeight));
  });

  context.fillStyle = "#667085";
  context.font = "12px sans-serif";
  context.textAlign = "left";
  context.fillText(formatMoney(max), 4, padding.top + 10);
  context.fillText("0", 18, padding.top + chartHeight);

  context.textAlign = "center";
  days.forEach((date, index) => {
    if (index % 3 !== 0 && index !== days.length - 1) return;
    context.fillText(`${date.getMonth() + 1}/${date.getDate()}`, padding.left + index * step + barWidth / 2, height - 8);
  });

  const daysSince = getDaysSinceLastOrder(tasks);
  lastOrderNotice.textContent = daysSince === undefined ? "暂无开单" : `${daysSince}天未开单`;
}

function renderTasks(tasks, runner) {
  ensureSimpleTaskCardStyles();
  const orderedTasks = sortTasksByAppointmentPriority(tasks);

  if (orderedTasks.length === 0) {
    tasksEl.innerHTML = `<div class="empty">还没有任务，先在左侧添加一个预约。</div>`;
    return;
  }

  tasksEl.innerHTML = orderedTasks.map((task, index) => {
    const fullName = `${task.customer.surname || ""}${task.customer.givenName || ""}`;
    const targetDate = taskTargetDate(task);
    const normalizedStatus = normalizeDashboardStatus(task.status);
    const cardTone = taskStatusTone(task);
    const signalTone = taskStatusSignalTone(task);
    const isWaitingCaptcha = isWaitingForActiveCaptcha(task);
    const isContinuing = task.status === "continuing";
    const isActiveTask = isTaskActivelyRunning(task) || runner?.activeTaskId === task.id;
    const canStartAssist = !isTaskActivelyRunning(task) && normalizedStatus !== "SUCCESS" && normalizedStatus !== "FAILED";
    const primaryAction = isWaitingCaptcha ? "continue-verification" : "assist-fill";
    const primaryActionLabel = isWaitingCaptcha ? "验证码已输入" : isContinuing ? "重启任务" : "启动任务";
    const primaryBusyLabel = isWaitingCaptcha ? "复核中" : isContinuing ? "重启中" : "启动中";
    const canPrimaryAction = isWaitingCaptcha || isContinuing || canStartAssist;
    const canForceUnlock = canForceUnlockTask(task, normalizedStatus);
    const recentLogs = (task.logs || []).slice(-6).reverse();
    const isArchivedTask = normalizedStatus === "FAILED" || isExpiredTask(task);
    const successFields = extractSuccessFields(task);
    const screenshotPath = task.successScreenshotPath || task.screenshotPath || task.screenshotFilePath || task.latestScreenshotPath || task.debugScreenshotPath || "";
    const appointmentNumber = successFields.referenceNumber || task.referenceNumber || task.appointmentNumber || "--";
    const appointmentTime = normalizeDisplayTime(successFields.appointmentTime || task.appointmentTime || task.bookedSlot?.time || "");
    const coreFields = [
      { label: "预约编号", value: appointmentNumber },
      { label: "预约日期", value: successFields.appointmentDate || task.appointmentDate || task.bookedSlot?.date || targetDate || "--" },
      { label: "预约时间", value: appointmentTime || "--" },
      { label: "分行区域", value: successFields.district || task.district || task.bookedSlot?.district || "--" },
      { label: "办理网点", value: successFields.branch || task.branch || task.bookedSlot?.branch || "--" },
      { label: "完成时间", value: task.completedAt ? formatClock(task.completedAt) : "--" },
      { label: "结果文件", value: task.resultJsonPath || task.resultPath || "--", link: true },
      { label: "成功截图", value: screenshotPath || "--", link: true },
    ];
    const taskName = taskDisplayName(index, task);
    const keyLine = taskKeyInfo(task, fullName);
    const statusLabel = normalizedStatusText[normalizeDashboardStatus(task.status)] || statusText[task.status] || task.status;
    const statusMarkup = renderInlineTaskStatus(task, statusLabel, signalTone);
    const primaryButtonClass = isActiveTask ? "primary runActive" : "primary ghost";
    const taskTop = `
      <div class="taskTop">
          <div>
            <div class="taskTitleRow">
              <div class="taskTitle">${escapeHtml(taskName)}</div>
              <div class="taskHeaderActions">
                ${statusMarkup}
                <button class="taskDeleteButton" data-action="delete" data-id="${task.id}" aria-label="删除任务">删除</button>
              </div>
            </div>
            <div class="taskMeta taskKeyInfo">${keyLine.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
          </div>
        </div>`;
    const taskBody = `
        <div class="primaryActionBlock">
          <button class="${primaryButtonClass}" data-action="${primaryAction}" data-id="${task.id}" data-busy-label="${primaryBusyLabel}" ${canPrimaryAction ? "" : "disabled"}>${primaryActionLabel}</button>
          ${canForceUnlock ? `<button class="forceUnlockButton" data-action="force-unlock" data-id="${task.id}">恢复启动</button>` : ""}
        </div>
        ${task.lastMessage ? `<div class="taskNotice">${escapeHtml(compactTaskMessage(task.lastMessage))}</div>` : ""}
        ${screenshotPath ? renderScreenshotPreview(screenshotPath) : ""}
        <details class="taskCoreDetails" ${isTaskSuccessful(task) || screenshotPath ? "open" : ""}>
          <summary>交付结果</summary>
          <div class="taskCore">
            ${coreFields.map(({ label, value, link }) => `
              <div class="taskCoreField">
                <span>${label}</span>
                <strong>${renderTaskCoreValue(value, link)}</strong>
              </div>
            `).join("")}
          </div>
        </details>
        <div class="taskActions">
          <button data-action="edit" data-id="${task.id}">修改</button>
          <button data-action="record-result" data-id="${task.id}">记录</button>
          <button data-action="mark-failed" data-id="${task.id}" ${normalizedStatus === "FAILED" ? "disabled" : ""}>失败</button>
          <button data-action="skip-date" data-id="${task.id}" ${targetDate && normalizedStatus !== "SUCCESS" ? "" : "disabled"}>跳过</button>
        </div>
        ${recordingTaskId === task.id ? renderRecordResultForm(task) : ""}
        ${recentLogs.length > 0 ? `
          <details class="taskLogs" data-task-logs="${task.id}" ${openLogTaskIds.has(task.id) ? "open" : ""}>
            <summary>最近日志</summary>
            <ol>
              ${recentLogs.map((log) => `<li class="log-${log.level}"><time>${escapeHtml(formatLogTime(log.at))}</time>${escapeHtml(compactTaskMessage(log.message))}</li>`).join("")}
            </ol>
          </details>
        ` : ""}
    `;

    if (isArchivedTask) {
      return `
        <details class="task taskCardSimple task-${cardTone} taskArchived" data-archived-task="${task.id}" ${openArchivedTaskIds.has(task.id) ? "open" : ""}>
          <summary>${taskTop}</summary>
          ${taskBody}
        </details>
      `;
    }

    return `
      <article class="task taskCardSimple task-${cardTone}">
        ${taskTop}
        ${taskBody}
      </article>
    `;
  }).join("");
}

function sortTasksByAppointmentPriority(tasks) {
  return [...tasks].sort((a, b) => {
    const aKey = taskAppointmentSortKey(a);
    const bKey = taskAppointmentSortKey(b);
    if (aKey !== bKey) return aKey - bKey;
    return String(a.createdAt || a.id || "").localeCompare(String(b.createdAt || b.id || ""));
  });
}

function taskAppointmentSortKey(task) {
  const date = task.appointmentDate || task.bookedSlot?.date || firstSortedValue(task.appointment?.preferredDates) || "9999-12-31";
  const time = normalizeSortTime(task.appointmentTime || task.bookedSlot?.time || firstSortedValue(task.appointment?.preferredTimes) || "23:59");
  const timestamp = Date.parse(`${date}T${time}:00`);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function firstSortedValue(values) {
  return (values || []).filter(Boolean).sort()[0] || "";
}

function normalizeSortTime(value) {
  const text = String(value || "").trim();
  const match = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!match) return "23:59";
  const hour = Math.max(0, Math.min(23, Number(match[1])));
  const minute = Math.max(0, Math.min(59, Number(match[2])));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function taskDisplayName(index, task) {
  const date = task.appointmentDate || task.bookedSlot?.date || taskTargetDate(task) || "未定日期";
  return `任务${index + 1} | ${date}`;
}

function taskKeyInfo(task, fullName) {
  const salutation = task.customer.salutation || "--";
  const phone = `${task.customer.countryCode || ""} ${task.customer.phone || ""}`.trim() || "--";
  const email = task.customer.email || "--";
  const dates = task.appointmentDate || task.bookedSlot?.date || (task.appointment.preferredDates || []).join("、") || "--";
  const times = task.appointmentTime || task.bookedSlot?.time || (task.appointment.preferredTimes || []).join("、") || "--";
  const districts = task.district || task.bookedSlot?.district || (task.appointment.preferredDistricts || []).join("、") || "--";
  return [
    fullName || "未填姓名",
    salutation,
    phone,
    `邮箱 ${email}`,
    `日期 ${dates}`,
    `时段 ${times}`,
    `区域 ${districts}`,
    selectionModeLabel(task.appointment.selectionMode)
  ];
}

function taskStatusTone(task) {
  const normalized = normalizeDashboardStatus(task.status);
  if (normalized === "SUCCESS") return "green";
  if (task.status === "waiting-human-verification" || normalized === "USER_ACTION_REQUIRED" || task.skippedTargetDate || normalized === "NO_RESULT" || normalized === "IDLE" || normalized === "SLEEPING" || normalized === "NORMAL_CHECK") {
    return "neutral";
  }
  if (isTaskActivelyRunning(task) || normalized === "PROCESSING" || normalized === "PREPARING" || normalized === "READY") return "yellow";
  if (normalized === "FAILED" || normalized === "NEEDS_REVIEW" || task.status === "needs-human") return "red";
  return "neutral";
}

function taskStatusSignalTone(task) {
  const normalized = normalizeDashboardStatus(task.status);
  if (normalized === "SUCCESS") return "green";
  if (task.status === "waiting-human-verification" || normalized === "USER_ACTION_REQUIRED" || normalized === "FAILED" || normalized === "NEEDS_REVIEW" || task.status === "needs-human") return "red";
  if (isTaskActivelyRunning(task) || normalized === "PROCESSING" || normalized === "PREPARING" || normalized === "READY") return "yellow";
  return "neutral";
}

function renderInlineTaskStatus(task, statusLabel, tone) {
  const waiting = isWaitingForActiveCaptcha(task);
  return `
    <span class="taskInlineStatus ${waiting ? "taskInlineStatusWaiting" : ""}">
      <span class="taskSignal taskSignal-${tone}" aria-hidden="true"></span>
      <span>${escapeHtml(statusLabel)}</span>
      ${waiting ? `<span class="animatedDots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>` : ""}
    </span>
  `;
}

function isWaitingForActiveCaptcha(task) {
  return task.status === "waiting-human-verification" && task.assistSessionActive !== false;
}

function isTaskActivelyRunning(task) {
  const assistManagedStatuses = new Set([
    "preparing-first-page",
    "waiting-human-verification",
    "prefilling-after-captcha",
    "prefilled-waiting-release",
    "release-scanning",
    "slot-locked",
    "final-submitting",
    "slot-full-scanning",
    "continuing"
  ]);
  return activeStatuses.has(task.status) && !(assistManagedStatuses.has(task.status) && task.assistSessionActive === false);
}

function canForceUnlockTask(task, normalizedStatus) {
  if (normalizedStatus === "SUCCESS" || normalizedStatus === "FAILED") return false;
  return isTaskActivelyRunning(task)
    || task.assistSessionActive === true
    || task.status === "waiting-human-verification"
    || task.status === "continuing"
    || task.status === "needs-human"
    || normalizedStatus === "USER_ACTION_REQUIRED"
    || normalizedStatus === "NEEDS_REVIEW";
}

function renderScreenshotPreview(path) {
  const url = taskAssetUrl(path);
  const absoluteUrl = absoluteTaskAssetUrl(path);
  const safePath = escapeHtml(path);
  const safeUrl = escapeHtml(url || path);
  const safeAbsoluteUrl = escapeHtml(absoluteUrl || url || path);
  return `
    <figure class="screenshotPreview">
      <button class="screenshotCopySurface" type="button" data-action="copy-image" data-url="${safeUrl}" title="复制这张成功截图">
        <img src="${safeUrl}" alt="预约截图">
      </button>
      <figcaption>
        <span>成功截图</span>
        <button type="button" data-action="copy-image" data-url="${safeUrl}">复制图片</button>
        <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">备用打开</a>
        <div class="screenshotLinkRow">
          <input readonly value="${safeAbsoluteUrl}" aria-label="成功截图链接">
          <button type="button" data-action="copy-asset-url" data-url="${safeAbsoluteUrl}">复制链接</button>
        </div>
        <small>${safePath}</small>
      </figcaption>
    </figure>
  `;
}

function renderManualTaskActions(task, normalizedStatus, hasTargetDate) {
  const buttons = [];
  if (normalizedStatus === "USER_ACTION_REQUIRED" || normalizedStatus === "REMINDER_WINDOW") {
    buttons.push(`<button class="primary" data-action="start-prepare" data-id="${task.id}">开始准备</button>`);
  }
  if (normalizedStatus === "NEEDS_REVIEW") {
    buttons.push(`<button class="primary ghost" data-action="continue-manual" data-id="${task.id}">我已处理，继续</button>`);
  }
  if (["PROCESSING", "PREPARING", "READY", "REMINDER_WINDOW", "USER_ACTION_REQUIRED"].includes(normalizedStatus)) {
    buttons.push(`<button data-action="pause-task" data-id="${task.id}">暂停任务</button>`);
  }
  if (normalizedStatus !== "SUCCESS") {
    buttons.push(`<button data-action="mark-success" data-id="${task.id}">标记完成</button>`);
  }
  if (normalizedStatus !== "FAILED") {
    buttons.push(`<button data-action="mark-failed" data-id="${task.id}">标记失败</button>`);
  }
  if (hasTargetDate && normalizedStatus !== "SUCCESS") {
    buttons.push(`<button data-action="skip-date" data-id="${task.id}">跳过该日期</button>`);
  }
  return buttons.join("");
}

function renderRecordResultForm(task) {
  return `
    <form class="recordResultForm" data-id="${task.id}">
      <div class="recordResultError" role="alert"></div>
      <label>
        <span>ID</span>
        <input name="referenceNumber" value="${escapeHtml(task.referenceNumber || task.appointmentNumber || "")}" required>
      </label>
      <label>
        <span>Date</span>
        <input name="appointmentDate" value="${escapeHtml(task.appointmentDate || "")}" placeholder="2026-05-20">
      </label>
      <label>
        <span>Time</span>
        <input name="appointmentTime" value="${escapeHtml(task.appointmentTime || "")}" placeholder="09:45">
      </label>
      <label>
        <span>District</span>
        <input name="district" value="${escapeHtml(task.district || "")}" placeholder="觀塘區">
      </label>
      <label>
        <span>Branch</span>
        <input name="branch" value="${escapeHtml(task.branch || "")}" placeholder="Test Location">
      </label>
      <label>
        <span>ScreenshotPath</span>
        <input name="successScreenshotPath" value="${escapeHtml(task.successScreenshotPath || task.screenshotPath || task.screenshotFilePath || task.latestScreenshotPath || task.debugScreenshotPath || "")}" placeholder="records/task-test/success.png">
      </label>
      <div class="recordResultFormActions">
        <button class="primary" type="button" data-action="save-record-result" data-id="${task.id}">保存</button>
        <button type="button" data-action="cancel-record-result" data-id="${task.id}">取消</button>
      </div>
    </form>
  `;
}

function renderTaskCoreValue(value, link) {
  const text = String(value || "--");
  if (!link || text === "--") return escapeHtml(text);
  const href = taskAssetUrl(text);
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}

function taskAssetUrl(path) {
  const text = String(path || "").trim();
  if (!text || text === "--") return "";
  if (/^(https?:|data:|blob:)/i.test(text)) return text;
  const recordsIndex = text.indexOf("records/");
  if (recordsIndex >= 0) return `/${text.slice(recordsIndex)}`;
  const debugIndex = text.indexOf("debug/");
  if (debugIndex >= 0) return `/${text.slice(debugIndex)}`;
  if (text.startsWith("/")) return text;
  return text;
}

function absoluteTaskAssetUrl(path) {
  const url = taskAssetUrl(path);
  if (!url) return "";
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  return `${window.location.origin}${url.startsWith("/") ? url : `/${url}`}`;
}

function compactTaskMessage(message) {
  const text = String(message || "").replace(/\u00a0/g, " ").trim();
  if (!text) return "";
  if (/辅助流程结果：/.test(text) && /您的預約已成功|您的预约已成功|參考編號|参考编号|預約編號|预约编号/.test(text)) {
    const reference = extractLabeledText(text, ["參考編號", "参考编号", "預約編號", "预约编号"]) || extractReferenceFromText(text) || "--";
    const date = normalizeDisplayDate(extractLabeledText(text, ["預約日期", "预约日期"])) || "--";
    const time = normalizeDisplayTime(extractLabeledText(text, ["預約時間", "预约时间"]) || "") || "--";
    const branch = extractLabeledText(text, ["選擇分行", "选择分行"]) || "--";
    return `辅助流程结果：预约成功，预约编号：${reference}，日期：${date}，时间：${time}，办理网点：${branch}`;
  }
  if (text.length <= 220) return text;
  return `${text.slice(0, 220)}...`;
}

function extractSuccessFields(task) {
  const text = String(task.confirmationText || task.lastMessage || "");
  const logSlot = extractLockedSlotFromLogs(task.logs || []);
  return {
    referenceNumber: extractLabeledText(text, ["參考編號", "参考编号", "預約編號", "预约编号"]) || extractReferenceFromText(text),
    appointmentDate: normalizeDisplayDate(extractLabeledText(text, ["預約日期", "预约日期"])) || "",
    appointmentTime: normalizeDisplayTime(extractLabeledText(text, ["預約時間", "预约时间"]) || ""),
    district: extractLabeledText(text, ["分行區域", "分行区域"]) || logSlot.district || "",
    branch: extractLabeledText(text, ["選擇分行", "选择分行"]) || logSlot.branch || "",
  };
}

function extractLabeledText(text, labels) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.replace(/\u00a0/g, " ").trim()).filter(Boolean);
  for (const line of lines) {
    for (const label of labels) {
      if (!line.startsWith(label)) continue;
      const value = line.slice(label.length).replace(/^[\s:：\-\t]+/, "").trim();
      if (value) return value;
    }
  }
  return "";
}

function extractReferenceFromText(text) {
  return String(text || "").match(/\b[A-Z]?[0-9][A-Z0-9-]{5,}\b/i)?.[0] || "";
}

function normalizeDisplayTime(value) {
  return String(value || "").match(/\b([01]?\d|2[0-3]):[0-5]\d\b/)?.[0] || "";
}

function normalizeDisplayDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (slash) return `${slash[3]}-${slash[2].padStart(2, "0")}-${slash[1].padStart(2, "0")}`;
  return text;
}

function extractLockedSlotFromLogs(logs) {
  const result = { district: "", branch: "" };
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const message = String(logs[index]?.message || "");
    const match = message.match(/已锁定号源：\s*(\S+)\s+(.+?)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}/);
    if (!match) continue;
    result.district = match[1] || "";
    result.branch = match[2] || "";
    return result;
  }
  return result;
}

function ensureSimpleTaskCardStyles() {
  if (document.querySelector("#simpleTaskCardStyles")) return;

  const style = document.createElement("style");
  style.id = "simpleTaskCardStyles";
  style.textContent = `
    .taskCardSimple {
      display: grid;
      gap: 14px;
    }

    .taskCardSimple .taskTop {
      align-items: flex-start;
      gap: 16px;
    }

    .taskCardSimple .taskTop > div {
      width: 100%;
      min-width: 0;
    }

    .taskArchived {
      padding: 14px 18px;
    }

    .taskArchived > summary {
      cursor: pointer;
      list-style: none;
    }

    .taskArchived > summary::-webkit-details-marker {
      display: none;
    }

    .taskCardSimple .taskTitle {
      margin-bottom: 6px;
    }

    .taskCore {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 10px 12px;
      margin-top: 10px;
    }

    .taskCoreField {
      min-width: 0;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.72);
    }

    .taskCoreField span {
      display: block;
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      line-height: 1.2;
    }

    .taskCoreField strong {
      display: block;
      color: var(--text);
      font-size: 14px;
      font-weight: 750;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    .taskCoreField:first-child,
    .taskCoreField:nth-last-child(-n + 2) {
      grid-column: 1 / -1;
    }

    .taskNotice {
      padding: 10px 12px;
      border: 1px solid rgba(255, 149, 0, 0.24);
      border-radius: 12px;
      background: rgba(255, 149, 0, 0.08);
      color: #8a4d00;
      font-size: 13px;
      font-weight: 750;
      line-height: 1.4;
    }

    .primaryActionBlock {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .forceUnlockButton {
      border-color: rgba(255, 149, 0, 0.3);
      color: #8a4d00;
      background: rgba(255, 149, 0, 0.08);
    }

    .taskCardSimple .taskActions {
      margin-top: 0;
      gap: 10px;
    }

    .taskCardSimple .taskActions button {
      min-width: 74px;
    }

    .taskHeaderActions {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
      margin-left: auto;
    }

    .taskDeleteButton {
      min-height: 30px;
      border-color: rgba(255, 59, 48, 0.18);
      background: rgba(255, 59, 48, 0.06);
      color: #9f241c;
      padding: 0 12px;
      font-size: 12px;
      box-shadow: none;
    }

    .taskDeleteButton:hover {
      border-color: rgba(255, 59, 48, 0.34);
      background: rgba(255, 59, 48, 0.1);
      color: #7f1d17;
    }

    .taskCardSimple .taskLogs {
      margin-top: -4px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.64);
    }

    .taskCoreDetails {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: rgba(242, 242, 247, 0.58);
      padding: 12px;
    }

    .taskCoreDetails summary {
      cursor: pointer;
      color: var(--muted);
      font-size: 13px;
      font-weight: 760;
      list-style: none;
    }

    .taskCoreDetails summary::-webkit-details-marker {
      display: none;
    }

    .screenshotPreview {
      margin: 0;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.76);
    }

    .screenshotPreview img {
      display: block;
      width: 100%;
      max-height: 320px;
      object-fit: contain;
      background: #f5f5f7;
    }

    .screenshotCopySurface {
      display: block;
      width: 100%;
      min-height: 0;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      cursor: copy;
    }

    .screenshotCopySurface:hover img {
      filter: brightness(0.98);
    }

    .screenshotPreview figcaption {
      display: grid;
      gap: 4px;
      padding: 10px 12px;
      border-top: 1px solid var(--border);
    }

    .screenshotPreview figcaption span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
    }

    .screenshotPreview figcaption a {
      color: var(--accent);
      font-size: 12px;
      font-weight: 650;
      overflow-wrap: anywhere;
    }

    .screenshotPreview figcaption > button {
      justify-self: start;
      min-height: 30px;
      padding: 0 12px;
      font-size: 12px;
    }

    .recordResultForm {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      padding: 14px;
      border: 1px solid #dbeafe;
      border-radius: 14px;
      background: #f8fbff;
    }

    .recordResultForm label {
      display: grid;
      gap: 6px;
      min-width: 0;
    }

    .recordResultForm label:first-of-type,
    .recordResultForm label:last-of-type,
    .recordResultError,
    .recordResultFormActions {
      grid-column: 1 / -1;
    }

    .recordResultForm span {
      color: #475569;
      font-size: 12px;
      font-weight: 700;
    }

    .recordResultForm input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #d8dee8;
      border-radius: 10px;
      padding: 10px 12px;
      color: #111827;
      font: inherit;
      background: #ffffff;
    }

    .recordResultError {
      min-height: 18px;
      color: #dc2626;
      font-size: 13px;
      font-weight: 700;
    }

    .recordResultFormActions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    }

    @media (max-width: 760px) {
      .taskCore {
        grid-template-columns: 1fr;
      }

      .taskCoreField:first-child,
      .taskCoreField:nth-last-child(-n + 2) {
        grid-column: auto;
      }

      .recordResultForm {
        grid-template-columns: 1fr;
      }
    }
  `;
  document.head.appendChild(style);
}

window.mockTestTaskCardRendering = function mockTestTaskCardRendering() {
  const previousHtml = tasksEl.innerHTML;
  const mockTask = {
    id: "mock-task-001",
    title: "Mock booking",
    status: "waiting-human-verification",
    customer: {
      surname: "Li",
      givenName: "Ming",
      countryCode: "+86",
      phone: "13800000000",
    },
    appointment: {
      preferredDates: ["2026-05-20"],
    },
    appointmentDate: "2026-05-20",
    appointmentTime: "09:30",
    branch: "Central",
    completedAt: "2026-05-20T09:45:00.000Z",
    resultJsonPath: "/tmp/mock-result.json",
    screenshotPath: "/tmp/mock-screenshot.png",
    logs: [
      { at: "2026-05-20T09:40:00.000Z", level: "info", message: "Mock log" },
    ],
  };

  try {
    renderTasks([mockTask], { running: false, activeTaskId: null });

    const card = tasksEl.querySelector(".task");
    const coreLabels = Array.from(card?.querySelectorAll(".taskCoreField span") || []).map((item) => item.textContent.trim());
    const buttonLabels = Array.from(card?.querySelectorAll(".taskActions button") || []).map((item) => item.textContent.trim());
    const actionNames = Array.from(card?.querySelectorAll(".taskActions button") || []).map((item) => item.dataset.action);
    const logs = card?.querySelector("details.taskLogs");

    return {
      coreFieldsDisplayed: ["预约编号", "预约日期", "预约时间", "分行区域", "办理网点", "完成时间", "结果文件", "成功截图"].every((label) => coreLabels.includes(label)),
      requiredButtonsExist: ["验证码已输入", "记录", "失败", "跳过"].every((label) => buttonLabels.includes(label)),
      redundantButtonsAbsent: ["open-real-form", "copy-chrome-script", "edit", "reset"].every((action) => !actionNames.includes(action)),
      logsFolded: Boolean(logs && !logs.open),
    };
  } finally {
    tasksEl.innerHTML = previousHtml;
  }
};

function formatLogTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function renderRunner(runner) {
  runnerState.textContent = runner.running ? "运行中" : "未运行";
  runnerState.className = `pill ${runner.running ? "status-running" : ""}`;
  startRunner.classList.toggle("runActive", Boolean(runner.running));
  startRunner.textContent = runner.running ? "预约运行中" : "开始预约";
  renderReleaseCountdown();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function refresh() {
  const state = await fetchState();
  latestTasks = state.tasks;
  latestRunner = state.runner;
  renderMetrics(state.summary);
  renderRhythmCard(state.tasks);
  renderRevenueTrend(state.tasks);
  renderTasks(state.tasks, state.runner);
  renderRunner(state.runner);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!updateRequiredNotice()) {
    taskDetails.open = true;
    return;
  }
  const payload = buildTaskPayload();
  if (!window.confirm(buildTaskConfirmationMessage(payload))) {
    return;
  }

  const response = await fetch(editingTaskId ? `/api/tasks/${editingTaskId}` : "/api/tasks", {
    method: editingTaskId ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    alert("添加任务失败");
    return;
  }
  resetTaskForm();
  await refresh();
});

form.rawConversation.addEventListener("input", () => {
  window.clearTimeout(form.rawConversation.parseTimer);
  form.rawConversation.parseTimer = window.setTimeout(applyParsedConversation, 350);
});

form.addEventListener("input", updateRequiredNotice);
form.addEventListener("change", updateRequiredNotice);
form.rawConversation.addEventListener("input", () => {
  if (String(form.rawConversation.value || "").trim()) {
    taskDetails.open = true;
  }
});

parseConversation.addEventListener("click", applyParsedConversation);

tasksEl.addEventListener("submit", (event) => {
  if (event.target.closest(".recordResultForm")) {
    event.preventDefault();
  }
});

tasksEl.addEventListener("toggle", (event) => {
  const details = event.target.closest?.("details[data-task-logs]");
  const archived = event.target.closest?.("details[data-archived-task]");
  if (details) {
    if (details.open) {
      openLogTaskIds.add(details.dataset.taskLogs);
    } else {
      openLogTaskIds.delete(details.dataset.taskLogs);
    }
    return;
  }
  if (archived) {
    if (archived.open) {
      openArchivedTaskIds.add(archived.dataset.archivedTask);
    } else {
      openArchivedTaskIds.delete(archived.dataset.archivedTask);
    }
  }
}, true);

tasksEl.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const id = button.dataset.id;
  const action = button.dataset.action;
  if (action === "copy-image") {
    const url = button.dataset.url;
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "复制中";
    const result = await copyImageToClipboard(url);
    button.disabled = false;
    button.textContent = originalText;
    alert(result.message);
    return;
  }
  if (action === "copy-asset-url") {
    await copyTextToClipboard(button.dataset.url || "");
    alert("已复制截图链接。");
    return;
  }
  if (action === "edit") {
    const task = latestTasks.find((item) => item.id === id);
    if (task) fillFormFromTask(task);
    return;
  }
  if (action === "assist-fill") {
    button.disabled = true;
    button.textContent = button.dataset.busyLabel || "打开中";
    const response = await fetch(`/api/tasks/${id}/assist-fill`, { method: "POST" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      alert(payload.error || "辅助填写启动失败，请检查服务日志。");
    }
    await refresh();
    return;
  }
  if (action === "open-real-form") {
    window.open("https://transaction.bochk.com/whk/form/openAccount/input.action?lang=zh_HK", "_blank", "noopener,noreferrer");
    return;
  }
  if (action === "copy-chrome-script") {
    const response = await fetch(`/api/tasks/${id}/chrome-fill-script`);
    if (!response.ok) {
      alert("生成填表脚本失败。");
      return;
    }
    const script = await response.text();
    await navigator.clipboard.writeText(script).catch(() => undefined);
    alert("已复制填表脚本。请打开真实表单页，在地址栏输入 javascript: 后粘贴脚本，或打开 DevTools Console 粘贴运行。");
    return;
  }
  if (action === "start-task") {
    button.disabled = true;
    button.textContent = "启动中";
    const response = await fetch(`/api/tasks/${id}/start`, { method: "POST" });
    if (!response.ok) {
      alert(response.status === 409 ? "已有任务正在预约中。" : "启动预约失败，请检查服务日志。");
    }
    await refresh();
    return;
  }
  if (action === "continue-verification") {
    button.disabled = true;
    button.textContent = button.dataset.busyLabel || "处理中";
    const response = await fetch(`/api/tasks/${id}/continue-verification`, { method: "POST" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      alert(payload.error || "继续执行失败，请检查服务日志。");
    }
    await refresh();
    return;
  }
  if (action === "force-unlock") {
    if (!confirm("确定恢复该任务的启动按钮？这会关闭该任务当前辅助浏览器会话。")) return;
    button.disabled = true;
    button.textContent = "恢复中";
    const response = await fetch(`/api/tasks/${id}/force-unlock`, { method: "POST" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      alert(payload.error || "恢复启动按钮失败，请检查服务日志。");
    }
    await refresh();
    return;
  }
  if (action === "record-result") {
    recordingTaskId = recordingTaskId === id ? null : id;
    renderTasks(latestTasks, latestRunner);
    return;
  }
  if (action === "cancel-record-result") {
    recordingTaskId = null;
    renderTasks(latestTasks, latestRunner);
    return;
  }
  if (action === "save-record-result") {
    event.preventDefault();
    console.log("[record-form] submit fired");
    const form = button.closest(".recordResultForm");
    const error = form?.querySelector(".recordResultError");
    const referenceNumberInput = form?.querySelector("[name='referenceNumber']");
    const referenceNumber = referenceNumberInput?.value.trim() || "";
    console.log("[record-form] id value =", referenceNumber);
    if (!referenceNumber) {
      console.log("[record-form] blocked empty id");
      if (error) error.textContent = "ID 必填，未记录成功结果。";
      return;
    }
    const appointmentDate = form?.querySelector("[name='appointmentDate']")?.value.trim() || "";
    const appointmentTime = form?.querySelector("[name='appointmentTime']")?.value.trim() || "";
    const district = form?.querySelector("[name='district']")?.value.trim() || "";
    const branch = form?.querySelector("[name='branch']")?.value.trim() || "";
    const successScreenshotPath = form?.querySelector("[name='successScreenshotPath']")?.value.trim() || "";
    const requestBody = {
      referenceNumber,
      appointmentDate,
      appointmentTime,
      district,
      branch,
      successScreenshotPath
    };
    console.log("[record-form] request body =", requestBody);
    const response = await fetch(`/api/tasks/${id}/record-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      if (error) error.textContent = "记录成功结果失败，请检查服务日志。";
      return;
    }
    recordingTaskId = null;
    await refresh();
    return;
  }
  const manualEndpoints = {
    "start-prepare": "start-prepare",
    "continue-manual": "continue",
    "pause-task": "pause",
    "mark-success": "mark-success",
    "mark-failed": "mark-failed",
    "skip-date": "skip-date"
  };
  if (manualEndpoints[action]) {
    if (action === "mark-success" && !confirm("确定将该任务标记为完成？")) return;
    if (action === "mark-failed" && !confirm("确定将该任务标记为失败？")) return;
    if (action === "skip-date" && !confirm("确定跳过该目标日期？")) return;
    button.disabled = true;
    const response = await fetch(`/api/tasks/${id}/${manualEndpoints[action]}`, { method: "POST" });
    if (!response.ok) {
      alert("人工控制操作失败，请检查服务日志。");
    }
    await refresh();
    return;
  }
  if (action === "delete") {
    if (!confirm("确定删除该任务？")) return;
    button.disabled = true;
    const response = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    if (!response.ok) alert("删除失败");
    await refresh();
    return;
  }
  const endpoint = action === "delete" ? `/api/tasks/${id}` : `/api/tasks/${id}/reset`;
  const response = await fetch(endpoint, { method: action === "delete" ? "DELETE" : "POST" });
  if (!response.ok) alert("操作失败");
  await refresh();
});

form.addEventListener("click", (event) => {
  const calendarNav = event.target.closest("button[data-calendar-nav]");
  if (calendarNav) {
    const direction = calendarNav.dataset.calendarNav;
    if (direction === "prev") {
      calendarViewMonth -= 1;
      if (calendarViewMonth < 0) {
        calendarViewMonth = 11;
        calendarViewYear -= 1;
      }
    } else if (direction === "next") {
      calendarViewMonth += 1;
      if (calendarViewMonth > 11) {
        calendarViewMonth = 0;
        calendarViewYear += 1;
      }
    }
    renderDateCalendar(selectedValues("preferredDates"));
    return;
  }

  const button = event.target.closest("button[data-select-all]");
  if (!button) return;
  const name = button.dataset.selectAll;
  const inputs = Array.from(form.querySelectorAll(`input[name="${name}"]:not(:disabled)`));
  const shouldCheck = inputs.some((input) => !input.checked);
  inputs.forEach((input) => {
    input.checked = shouldCheck;
  });
  updateRequiredNotice();
});

cancelEdit.addEventListener("click", resetTaskForm);

startRunner.addEventListener("click", async () => {
  const response = await fetch("/api/runner/start", { method: "POST" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    alert(payload.error || "启动 Runner 失败，请检查服务日志。");
  }
  await refresh();
});

stopRunner.addEventListener("click", async () => {
  await fetch("/api/runner/stop", { method: "POST" });
  await refresh();
});

openDebugFolder.addEventListener("click", async () => {
  const response = await fetch("/api/debug/open", { method: "POST" });
  if (!response.ok) {
    alert("打开 debug 文件夹失败，请检查服务日志。");
  }
});

async function copyImageToClipboard(url) {
  if (!url) return { ok: false, message: "没有找到截图。" };
  const absoluteUrl = absoluteTaskAssetUrl(url) || url;
  if (!navigator.clipboard?.write || !window.ClipboardItem) {
    await copyTextToClipboard(absoluteUrl);
    return { ok: false, message: "当前浏览器不支持直接复制图片，已复制截图链接。" };
  }

  try {
    const pngBlob = await loadImageAsPngBlob(absoluteUrl);
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": pngBlob,
        "text/html": new Blob([`<img src="${escapeAttribute(absoluteUrl)}" alt="success screenshot">`], { type: "text/html" }),
        "text/plain": new Blob([absoluteUrl], { type: "text/plain" })
      })
    ]);
    return { ok: true, message: "已复制截图图片。" };
  } catch (error) {
    console.warn("copy image failed", error);
  }

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([`<img src="${escapeAttribute(absoluteUrl)}" alt="success screenshot">`], { type: "text/html" }),
        "text/plain": new Blob([absoluteUrl], { type: "text/plain" })
      })
    ]);
    return { ok: false, message: "图片复制受浏览器限制，已复制可粘贴的图片引用。" };
  } catch {
    await copyTextToClipboard(absoluteUrl);
    return { ok: false, message: "图片复制受浏览器限制，已复制截图链接。" };
  }
}

function loadImageAsPngBlob(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Canvas is not available"));
        return;
      }
      context.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Could not create PNG blob"));
        }
      }, "image/png");
    };
    image.onerror = () => reject(new Error("Could not load screenshot image"));
    image.src = `${url}${url.includes("?") ? "&" : "?"}copy=${Date.now()}`;
  });
}

function escapeAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}

clearDebugFiles.addEventListener("click", async () => {
  if (!confirm("确定清空 debug 文件？当前 run.log、截图和 trace 都会删除。")) {
    return;
  }
  const response = await fetch("/api/debug/clear", { method: "POST" });
  if (!response.ok) {
    alert("清空 debug 文件失败，请检查服务日志。");
    return;
  }
  alert("debug 文件已清空。新的 run.log 已写入清理记录。");
});

resetTaskForm();
await refresh();
renderReleaseCountdown();
setInterval(refresh, 5000);
setInterval(() => {
  renderReleaseCountdown();
  renderRhythmCard(latestTasks);
}, 1000);
