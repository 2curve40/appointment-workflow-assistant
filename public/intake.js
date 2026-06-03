const form = document.querySelector("#intakeForm");
const message = document.querySelector("#intakeMessage");
const customDistrictLabel = document.querySelector("#customDistrictLabel");
const reviewPanel = document.querySelector("#reviewPanel");
const reviewContent = document.querySelector("#reviewContent");
const editButton = document.querySelector("#editButton");
const confirmButton = document.querySelector("#confirmButton");
const params = new URLSearchParams(window.location.search);
const token = params.get("token") || "";
const apiBase = window.location.protocol === "file:" ? "http://127.0.0.1:4173" : "";

let pendingPayload = null;

form.district.addEventListener("change", () => {
  const isCustom = form.district.value === "custom";
  customDistrictLabel.hidden = !isCustom;
  form.customDistrict.required = isCustom;
  if (!isCustom) {
    form.customDistrict.value = "";
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  message.className = "message";

  const payload = buildPayload();
  if (payload.preferredTimes.length === 0) {
    message.className = "message error";
    message.textContent = "请至少选择一个可接受时段。";
    return;
  }

  pendingPayload = payload;
  renderReview(payload);
  form.hidden = true;
  reviewPanel.hidden = false;
  message.textContent = "";
  reviewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
});

editButton.addEventListener("click", () => {
  reviewPanel.hidden = true;
  form.hidden = false;
  message.className = "message";
  message.textContent = "请修改后再次检查。";
  form.scrollIntoView({ behavior: "smooth", block: "start" });
});

confirmButton.addEventListener("click", async () => {
  if (!pendingPayload) {
    return;
  }

  confirmButton.disabled = true;
  editButton.disabled = true;
  setReviewMessage("正在提交...");

  try {
    const response = await fetch(`${apiBase}/api/intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pendingPayload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || "提交失败");
    }

    form.reset();
    pendingPayload = null;
    reviewPanel.hidden = true;
    form.hidden = false;
    customDistrictLabel.hidden = true;
    form.customDistrict.required = false;
    message.className = "message success";
    message.textContent = `提交成功，编号：${result.taskId}`;
  } catch (error) {
    setReviewMessage(error instanceof Error ? error.message : "提交失败，请稍后再试", true);
  } finally {
    confirmButton.disabled = false;
    editButton.disabled = false;
  }
});

function buildPayload() {
  const data = new FormData(form);
  const surname = clean(data.get("surname"));
  const givenName = clean(data.get("givenName"));
  const districtValue = clean(data.get("district"));
  const customDistrict = clean(data.get("customDistrict"));
  const district = districtValue === "custom" ? customDistrict : districtValue;
  const preferredTimes = data.getAll("preferredTimes").map(clean).filter(Boolean);

  return {
    token,
    title: `${surname}${givenName} ${clean(data.get("preferredDate"))}`,
    documentType: clean(data.get("documentType")),
    accountType: clean(data.get("accountType")),
    salutation: clean(data.get("salutation")),
    surname,
    givenName,
    fullName: `${surname}${givenName}`,
    countryCode: clean(data.get("countryCode")),
    phone: clean(data.get("phone")),
    email: clean(data.get("email")),
    preferredDate: clean(data.get("preferredDate")),
    preferredTimes,
    selectionMode: clean(data.get("selectionMode")),
    district,
    branch: clean(data.get("branch")),
    note: clean(data.get("note"))
  };
}

function renderReview(payload) {
  reviewPanel.querySelector(".reviewMessage")?.remove();
  const rows = [
    ["證件種類", payload.documentType],
    ["開立賬戶種類", payload.accountType],
    ["稱謂", payload.salutation],
    ["姓名", `${payload.surname}${payload.givenName}`],
    ["國家/區域編號", payload.countryCode],
    ["流動電話號碼", payload.phone],
    ["電郵地址", payload.email],
    ["目标日期", payload.preferredDate],
    ["可接受時段", payload.preferredTimes.join("、")],
    ["区域", payload.district],
    ["网点偏好", payload.branch],
    ["选择方式", selectionModeLabel(payload.selectionMode)],
    ["备注", payload.note || "-"]
  ];

  reviewContent.innerHTML = rows
    .map(([label, value]) => `
      <div class="reviewItem">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value || "-")}</strong>
      </div>
    `)
    .join("");
}

function setReviewMessage(text, isError = false) {
  let reviewMessage = reviewPanel.querySelector(".reviewMessage");
  if (!reviewMessage) {
    reviewMessage = document.createElement("p");
    reviewMessage.className = "reviewMessage";
    reviewPanel.append(reviewMessage);
  }
  reviewMessage.className = isError ? "reviewMessage error" : "reviewMessage";
  reviewMessage.textContent = text;
}

function selectionModeLabel(value) {
  return value === "branch-first" ? "先選定分行" : "先選定預約日期和時間";
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
