import type { PartialDeep } from "./types-private.js";
import type { BookingRequest } from "../types.js";

const districtHints: Record<string, string> = {
  "中环": "Central and Western",
  "上环": "Central and Western",
  "湾仔": "Wan Chai",
  "銅鑼灣": "Wan Chai",
  "铜锣湾": "Wan Chai",
  "尖沙咀": "Yau Tsim Mong",
  "旺角": "Yau Tsim Mong",
  "油麻地": "Yau Tsim Mong"
};

export function parseXianyuConversation(raw: string): PartialDeep<BookingRequest> {
  const phoneMatch = raw.match(/(?:\+?86[-\s]?)?(1[3-9]\d[\s-]?\d{4}[\s-]?\d{4})|(?:\+?852[-\s]?)?([569]\d{3}[\s-]?\d{4})/);
  const phone = (phoneMatch?.[1] || phoneMatch?.[2])?.replace(/\D/g, "");
  const email = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const explicitSalutation = raw.match(/先生|小姐|太太|女士/)?.[0] as BookingRequest["customer"]["salutation"] | undefined;
  const salutation = explicitSalutation
    ?? (/(?:^|[\s，,。；;:：])女(?:性|士)?(?:$|[\s，,。；;:：])/.test(raw) ? "女士" : undefined)
    ?? (/(?:^|[\s，,。；;:：])男(?:性|士)?(?:$|[\s，,。；;:：])/.test(raw) ? "先生" : undefined);
  const preferredDistricts = Object.entries(districtHints)
    .filter(([keyword]) => raw.includes(keyword))
    .map(([, district]) => district);

  const timeWindows = [];
  if (/上午|早上|中午前/.test(raw)) {
    timeWindows.push({ start: "09:00", end: "12:30" });
  }
  if (/下午|午後|午后|2点后|兩點後|两点后/.test(raw)) {
    timeWindows.push({ start: "14:00", end: "17:00" });
  }

  return {
    customer: {
      salutation,
      phone,
      email
    },
    appointment: {
      preferredDistricts: [...new Set(preferredDistricts)],
      preferredDates: undefined,
      preferredTimes: undefined,
      timeWindows: timeWindows.length > 0 ? timeWindows : undefined
    }
  };
}
