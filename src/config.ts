import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { BookingRequest } from "./types.js";

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

const bookingRequestSchema = z.object({
  customer: z.object({
    salutation: z.enum(["先生", "小姐", "太太", "女士"]).default("先生"),
    surname: z.string().min(1),
    givenName: z.string().min(1),
    countryCode: z.string().min(1).default("852 香港"),
    phone: z.string().min(6),
    email: z.string().email(),
    documentType: z.string().min(1).default("中國居民身份證"),
    accountType: z.string().min(1).default("一般賬戶")
  }),
  appointment: z.object({
    preferredDistricts: z.array(z.string()).default([]),
    preferredBranches: z.array(z.string()).default([]),
    preferredDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
    preferredTimes: z.array(z.string().regex(timePattern)).default([]),
    selectionMode: z.enum(["date-first", "branch-first"]).default("date-first"),
    timeWindows: z.array(
      z.object({
        start: z.string().regex(timePattern),
        end: z.string().regex(timePattern)
      })
    ).min(1),
    daysAhead: z.number().int().min(0).max(30).default(7)
  }),
  runner: z.object({
    headless: z.boolean().default(false),
    releaseWindowRefreshIntervalMs: z.number().int().min(1000).default(1500),
    normalRefreshIntervalMs: z.number().int().min(5000).default(900000),
    releaseWindowBeforeMs: z.number().int().min(0).default(10000),
    releaseWindowAfterMs: z.number().int().min(1000).default(120000),
    maxAttempts: z.number().int().min(0).default(0)
  }),
  xianyu: z.object({
    rawConversation: z.string().optional()
  }).optional()
});

export async function loadBookingRequest(path: string): Promise<BookingRequest> {
  const raw = await readFile(path, "utf8");
  return bookingRequestSchema.parse(JSON.parse(raw));
}
