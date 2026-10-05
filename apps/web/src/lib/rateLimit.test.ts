/**
 * The rate limit as the user reads it (2026-10-05): keyed on the server's
 * CODE from either client, never on its English words; the wait in whole
 * seconds or minutes, rounded UP; Arabic with its number agreement.
 */
import { describe, expect, it } from "vitest";
import { limiterUnavailableMessage, rateLimitMessage, rateLimitWait, rateLimitedSeconds, rateLimitedSecondsOf } from "./rateLimit";

const en = (e: string) => e;
const ar = (_e: string, a: string) => a;

describe("recognising the rate limit", () => {
  it("is the 429 with code rate_limited — not every 429, and not the words", () => {
    expect(rateLimitedSeconds(429, { code: "rate_limited", retryAfterSeconds: 42 })).toBe(42);
    expect(rateLimitedSeconds(429, { code: "rate_limited", retryAfterSeconds: 41.2 })).toBe(42);
    expect(rateLimitedSeconds(429, { error: "Too many requests" })).toBeNull(); // no code → not ours to explain
    expect(rateLimitedSeconds(503, { code: "rate_limited", retryAfterSeconds: 5 })).toBeNull();
    expect(rateLimitedSeconds(429, { code: "rate_limited" }), "a missing wait is a minute, never zero").toBe(60);
    expect(rateLimitedSeconds(429, null)).toBeNull();
  });

  it("reads both clients' error shapes: apiFetch (`body`) and the generated client (`data`)", () => {
    const body = { code: "rate_limited", retryAfterSeconds: 7, error: "Too many requests…" };
    expect(rateLimitedSecondsOf(Object.assign(new Error("x"), { status: 429, body }))).toBe(7);
    expect(rateLimitedSecondsOf(Object.assign(new Error("HTTP 429 Too Many Requests: …"), { status: 429, data: body }))).toBe(7);
    expect(rateLimitedSecondsOf(new Error("plain"))).toBeNull();
    expect(rateLimitedSecondsOf(undefined)).toBeNull();
  });
});

describe("the limiter being unavailable (503 rate_limit_unavailable)", () => {
  it("has its own sentence in each language, keyed on the code", () => {
    expect(limiterUnavailableMessage(503, { code: "rate_limit_unavailable" }, en)).toBe("The service is temporarily unavailable. Please try again shortly.");
    expect(limiterUnavailableMessage(503, { code: "rate_limit_unavailable" }, ar)).toBe("الخدمة غير متاحة مؤقتًا. يُرجى المحاولة مرة أخرى بعد قليل.");
    expect(limiterUnavailableMessage(503, { code: "pdf_renderer_unavailable" }, en), "another 503 keeps its own words").toBeNull();
    expect(limiterUnavailableMessage(500, { code: "rate_limit_unavailable" }, en)).toBeNull();
  });
});

describe("the wait, in words", () => {
  it("English: seconds below 90, then whole minutes rounded up", () => {
    expect(rateLimitWait(1, en)).toBe("1 second");
    expect(rateLimitWait(45, en)).toBe("45 seconds");
    expect(rateLimitWait(89, en)).toBe("89 seconds");
    expect(rateLimitWait(90, en)).toBe("2 minutes");
    expect(rateLimitWait(61 * 60 - 1, en)).toBe("61 minutes");
    expect(rateLimitWait(900, en)).toBe("15 minutes");
  });

  it("🔴 Arabic agrees with its number: 1, 2, 3–10, 11 and up take different forms", () => {
    expect(rateLimitWait(1, ar)).toBe("ثانية واحدة");
    expect(rateLimitWait(2, ar)).toBe("ثانيتين");
    expect(rateLimitWait(5, ar)).toBe("5 ثوانٍ");
    expect(rateLimitWait(10, ar)).toBe("10 ثوانٍ");
    expect(rateLimitWait(30, ar)).toBe("30 ثانية");
    expect(rateLimitWait(120, ar)).toBe("دقيقتين");
    expect(rateLimitWait(600, ar)).toBe("10 دقائق");
    expect(rateLimitWait(900, ar)).toBe("15 دقيقة");
    expect(rateLimitWait(3600, ar)).toBe("60 دقيقة");
  });

  it("the sentence, in each language, carries the wait", () => {
    expect(rateLimitMessage(30, en)).toBe("Too many requests. Please try again in 30 seconds.");
    expect(rateLimitMessage(30, ar)).toBe("عدد الطلبات كبير جدًا. يُرجى المحاولة مرة أخرى بعد 30 ثانية.");
  });
});
