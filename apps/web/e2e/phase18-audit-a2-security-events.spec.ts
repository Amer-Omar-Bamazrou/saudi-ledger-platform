/**
 * 🔴 Phase 18 audit (2026-11-09), finding A2 — an organization's admin reads its security events on the Users page.
 *
 * DR-27's decision was a "tenant-visible audit": a password reset (an admin's, or an operator's break-glass), an
 * invitation, a membership change are recorded for the organization. It was built to `GET /orgs/:orgId/security-events`
 * and no screen called it, so no tenant user could read any of it in the product. The fixture is an invitation sent
 * through the API (it records `invite.sent`); the read is the page, in Arabic, at phone width.
 */
import { expect, test } from "@playwright/test";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

test("🔴 A2: the admin's Users page lists the organization's security events, newest first, with the total", async ({ browser, request }) => {
  const orgs = await request.get("/api/orgs");
  expect(orgs.ok(), await orgs.text()).toBe(true);
  const orgId = ((await orgs.json()) as { activeOrgId: string }).activeOrgId;
  const email = `a2-walk-${Date.now()}@example.test`;
  const sent = await request.post(`/api/orgs/${orgId}/invitations`, { data: { email, role: "viewer" } });
  expect(sent.ok(), await sent.text()).toBe(true);
  const invitationId = ((await sent.json()) as { id: string }).id;

  const first = await request.get(`/api/orgs/${orgId}/security-events?limit=1`);
  expect(first.ok(), await first.text()).toBe(true);
  const newest = ((await first.json()) as { events: Array<{ id: string; action: string }>; total: number });
  expect(newest.events[0]?.action).toBe("invite.sent");

  const ctx = await browser.newContext({ storageState: E2E.storageState, viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("ksa_lang", "ar"); } catch { /* the default language */ } });
  const page = await ctx.newPage();
  try {
    await page.goto("/users", { waitUntil: "networkidle" });
    const card = page.getByTestId("security-events");
    await expect(card).toBeVisible();
    const row = page.getByTestId(`security-event-${newest.events[0]!.id}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("دعوة");
    await expect(page.getByTestId("security-events-count")).toContainText(String(newest.total));
  } finally {
    await ctx.close();
    await request.delete(`/api/orgs/${orgId}/invitations/${invitationId}`);
  }
});
