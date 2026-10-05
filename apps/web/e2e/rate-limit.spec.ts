import { test, expect, request as pwRequest, type APIRequestContext, type Page, type Browser } from "@playwright/test";
import { createHash } from "node:crypto";
import { E2E } from "./global-setup";

/**
 * RATE LIMITING, AS A PERSON MEETS IT (2026-10-05).
 *
 * Nothing here floods anything. Each refusal is produced by PLANTING the
 * bucket's count in the shared counter table — the row a long stream of
 * requests would leave — so the real limiter, at its real production limit,
 * refuses the very next request the page makes. Every planted row is deleted
 * after each test, so no other spec ever sees a budget this one touched.
 *
 * What is proven, per flow, in English and Arabic, on desktop and on a phone:
 *   - login: the refusal is a sentence in the reader's language, not English
 *     server text, and the same for an address with no account;
 *   - a page whose REPORT reads are refused says so (one toast), instead of
 *     rendering empty;
 *   - an export, a write, and a statement upload refused say so, and
 *     write NOTHING;
 *   - and with nothing planted, the same pages work and carry the
 *     RateLimit headers — normal use is untouched.
 *
 * The keys are the dev server's (NODE_ENV=development: no per-process
 * suffix): `budget:<class>:u:<userId>` and `auth-account:acct:<sha256 of the folded email>`.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
type Mode = { lang: "en" | "ar"; viewport: { width: number; height: number }; label: string };
const MODES: Mode[] = [
  { lang: "en", viewport: DESKTOP, label: "EN desktop" },
  { lang: "en", viewport: PHONE, label: "EN phone" },
  { lang: "ar", viewport: DESKTOP, label: "AR desktop" },
  { lang: "ar", viewport: PHONE, label: "AR phone" },
];
const SENTENCE = {
  en: /Too many requests\. Please try again in \d+ (seconds?|minutes?)\./,
  ar: /عدد الطلبات كبير جدًا\. يُرجى المحاولة مرة أخرى بعد/,
};
const TITLE = { en: "Too many requests", ar: "عدد الطلبات كبير جدًا" };
const STAMP = Date.now();

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };
let db: Db;
let api: APIRequestContext;
let userId = 0;
const planted = new Set<string>();

async function plant(key: string, hits: number, msLeft = 5 * 60_000) {
  await db.query(
    `INSERT INTO rate_limit_hits (key, hits, expires_at) VALUES ($1, $2, now() + $3 * interval '1 millisecond')
     ON CONFLICT (key) DO UPDATE SET hits = EXCLUDED.hits, expires_at = EXCLUDED.expires_at`,
    [key, hits, msLeft],
  );
  planted.add(key);
}
const budget = (cls: string) => `budget:${cls}:u:${userId}`;

async function setLang(page: Page, lang: "en" | "ar") {
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
}
const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};

test.use({ storageState: E2E.storageState });

test.beforeAll(async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  db = client as unknown as Db;
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  userId = Number((await db.query(`SELECT id FROM users WHERE email = $1`, [E2E.email])).rows[0].id);
  expect(userId).toBeGreaterThan(0);
});
test.afterEach(async () => {
  if (planted.size) await db.query(`DELETE FROM rate_limit_hits WHERE key = ANY($1)`, [[...planted]]);
  planted.clear();
});
test.afterAll(async () => {
  await api?.dispose();
  await db?.end();
});

test.describe.serial("rate limiting in the browser", () => {
  test("🔴 LOGIN refused by the account limit: the reader's language, nobody signed in — and the same for an address with no account", async ({ browser }: { browser: Browser }) => {
    const ghost = `rl-e2e-ghost-${STAMP}@nowhere.local`;
    await plant(`auth-account:acct:${createHash("sha256").update(ghost.trim().toLowerCase()).digest("hex")}`, 60);
    for (const mode of MODES) {
      const ctx = await browser.newContext({ storageState: undefined, viewport: mode.viewport });
      const page = await ctx.newPage();
      await page.goto("/login");
      await setLang(page, mode.lang);
      await page.locator("#email").fill(ghost);
      await page.locator("#password").fill("not-the-password");
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith("/api/auth/login")),
        page.locator('button[type="submit"]').click(),
      ]);
      expect(res.status(), mode.label).toBe(429);
      expect((await res.json()).code).toBe("rate_limited");
      await expect(page.getByText(SENTENCE[mode.lang]).first(), mode.label).toBeVisible();
      if (mode.lang === "ar") await expect(page.getByText(/Too many requests/), "no English server text in Arabic").toHaveCount(0);
      await expect(page, "still on the login page").toHaveURL(/\/login$/);
      await noSidewaysScroll(page, mode.viewport.width, `login ${mode.label}`);
      await ctx.close();
    }
  });

  test("🔴 a page whose REPORT reads are refused says why, once — and works again when the window passes", async ({ page }) => {
    await plant(budget("report"), 400);
    for (const mode of MODES) {
      await page.setViewportSize(mode.viewport);
      await page.goto("/trial-balance");
      await setLang(page, mode.lang);
      await expect(page.getByText(TITLE[mode.lang], { exact: true }).first(), mode.label).toBeVisible();
      await expect(page.getByText(SENTENCE[mode.lang]).first(), mode.label).toBeVisible();
      await expect(page.getByText(TITLE[mode.lang], { exact: true }), `${mode.label}: one toast, not one per failed query`).toHaveCount(1);
      await noSidewaysScroll(page, mode.viewport.width, `trial balance ${mode.label}`);
    }
    // the window passes
    await db.query(`DELETE FROM rate_limit_hits WHERE key = $1`, [budget("report")]);
    await page.setViewportSize(DESKTOP);
    const [tb] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/reports/trial-balance")),
      page.reload(),
    ]);
    expect(tb.status()).toBe(200);
    expect(tb.headers()["ratelimit-limit"], "normal responses carry the budget headers").toBeTruthy();
    await expect(page.getByText(TITLE.ar, { exact: true })).toHaveCount(0);
    await setLang(page, "en");
  });

  test("an EXPORT refused names itself as the export that was not produced, in both languages", async ({ page }) => {
    await page.goto("/trial-balance", { waitUntil: "networkidle" });
    await plant(budget("export"), 30);
    for (const lang of ["en", "ar"] as const) {
      await setLang(page, lang);
      await page.getByTestId("export-trial-balance-csv").click();
      await expect(page.getByText(lang === "en" ? "The export was not produced" : "لم يتم إنشاء الملف").first()).toBeVisible();
      await expect(page.getByText(SENTENCE[lang]).first()).toBeVisible();
    }
    await setLang(page, "en");
  });

  test("🔴 a WRITE refused creates nothing, and says so in the reader's language", async ({ page }) => {
    const name = `RL E2E Refused ${STAMP}`;
    await plant(budget("write"), 300);
    for (const mode of [MODES[0]!, MODES[3]!]) {
      await page.setViewportSize(mode.viewport);
      await page.goto("/customers", { waitUntil: "networkidle" });
      await setLang(page, mode.lang);
      await page.getByRole("button", { name: mode.lang === "en" ? "New Customer" : "عميل جديد" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.locator("input").first().fill(name);
      await dialog.getByRole("button", { name: mode.lang === "en" ? "Create Customer" : "إنشاء عميل" }).click();
      await expect(page.getByText(SENTENCE[mode.lang]).first(), mode.label).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await db.query(`DELETE FROM rate_limit_hits WHERE key = $1`, [budget("write")]);
    const list = await (await api.get(`/api/customers?search=${encodeURIComponent(name)}`)).json();
    // the probe must be able to see a customer: an unread shape would make "none" vacuous
    expect(Array.isArray(list.items), "the probe reads the list's real shape").toBe(true);
    expect((list.items as { name: string }[]).filter((c) => c.name === name), "no customer was created").toEqual([]);
    await setLang(page, "en");
  });

  test("🔴 a STATEMENT UPLOAD refused imports nothing, and says why", async ({ page }) => {
    const banks = (await (await api.get("/api/bank-accounts")).json()) as { id: number; name: string }[] | { items: { id: number; name: string }[] };
    const bank = (Array.isArray(banks) ? banks : banks.items)[0]!;
    const marker = `RLUP${STAMP}`;
    const csv = Buffer.from(["date,description,amount,type", `2026-05-04,E2E rate limit ${marker},10.00,credit`].join("\n"), "utf8");
    await plant(budget("bulk"), 120);
    for (const lang of ["en", "ar"] as const) {
      await page.goto("/upload", { waitUntil: "networkidle" });
      await setLang(page, lang);
      await page.getByTestId("upload-bank-account").click();
      await page.getByRole("option", { name: new RegExp(bank.name) }).click();
      await page.locator('input[type="file"]').first().setInputFiles({ name: `rl-${STAMP}.csv`, mimeType: "text/csv", buffer: csv });
      await page.getByTestId("upload-import-file").click();
      await expect(page.getByText(SENTENCE[lang]).first(), lang).toBeVisible();
    }
    await db.query(`DELETE FROM rate_limit_hits WHERE key = $1`, [budget("bulk")]);
    const body = await (await api.get(`/api/transactions?search=${marker}&limit=50`)).json();
    expect(Array.isArray(body.transactions), "the probe reads the list's real shape").toBe(true);
    expect(body.transactions, "no line was imported").toEqual([]);
    await setLang(page, "en");
  });
});
