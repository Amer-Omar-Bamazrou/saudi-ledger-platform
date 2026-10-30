/**
 * 🔴 PHASE 18 H-15 — A PASSWORD SOMEONE ELSE SET, CHANGED BY CLICKING (DR-06
 * part 1, DR-27; each owner accepted the recommendation; register §11.66). An
 * admin creates an account with a password; its holder signs in and sees ONLY
 * Change password — nothing else of the app — changes it there, and the app
 * opens. The screen the holder is held on is the one under test (a server test
 * cannot see it).
 */
import { test, expect, request as pwRequest, type APIRequestContext } from "./fixtures";
import { E2E } from "./global-setup";

const STAMP = Date.now();
const EMAIL = `e2e-h15-${STAMP}@test.local`;
const SET = "E2E-H15-set-by-admin-1!";
const MINE = "E2E-H15-my-own-choice-9!";

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const me = await (await api.get("/api/auth/me")).json();
  const r = await api.post("/api/auth/register", {
    data: { email: EMAIL, name: "E2E H15 Holder", password: SET, role: "viewer", organizationId: me.organizationId },
  });
  if (!r.ok()) throw new Error(`register → ${r.status()} ${(await r.text()).slice(0, 300)}`);
});
test.afterAll(async () => { await api.dispose(); });

test("🔴 the holder of an admin-set password sees only Change password until they choose their own — then the app opens", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: "http://localhost:5173" }); // signed out: the holder's own browser
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(SET);
  await page.locator("#password").press("Enter");

  const held = page.getByTestId("password-change-required");
  await expect(held, "held on Change password, on its own").toBeVisible();
  await expect(page.getByTestId("password-change-required-reason")).toBeVisible();

  await held.locator("#current").fill(SET);
  await held.locator("#next").fill(MINE);
  await held.locator("#confirm").fill(MINE);
  await held.locator('form button[type="submit"]').click();

  await expect(held, "the app opens once the holder's own password is set").toHaveCount(0);
  await expect.poll(async () => (await (await ctx.request.get("/api/auth/me")).json()).passwordChangeRequired).toBe(false);
  await ctx.close();
});
