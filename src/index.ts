import { loadBookingRequest } from "./config.js";
import { BochkAppointmentBot } from "./bochk/browser.js";
import { getReleaseWindowState, sleep } from "./scheduler.js";
import { parseXianyuConversation } from "./xianyu/parser.js";

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const configPath = getArg("--config") ?? "config/example.request.json";
  const request = await loadBookingRequest(configPath);

  if (request.xianyu?.rawConversation) {
    const parsed = parseXianyuConversation(request.xianyu.rawConversation);
    console.log("[xianyu] extracted hints:", JSON.stringify(parsed, null, 2));
  }

  const bot = new BochkAppointmentBot(request);
  await bot.open();

  let attempts = 0;
  try {
    while (request.runner.maxAttempts === 0 || attempts < request.runner.maxAttempts) {
      attempts += 1;
      const now = new Date();
      const state = getReleaseWindowState(now, request);
      console.log(
        `[attempt ${attempts}] ${now.toLocaleString()} releaseWindow=${state.inReleaseWindow}`
      );

      const result = await bot.tryBookOnce();
      if (result.status === "booked") {
        console.log("[booked]", result.confirmationText);
        console.log("[slot]", result.slot);
        return;
      }

      if (result.status === "needs-human") {
        console.log("[needs-human]", result.reason);
        console.log("浏览器会保持打开，请人工处理后重新运行或继续观察页面。");
        await sleep(60 * 60 * 1000);
        return;
      }

      console.log("[no-slot]", result.reason);
      await sleep(state.refreshIntervalMs);
    }
  } finally {
    await bot.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
