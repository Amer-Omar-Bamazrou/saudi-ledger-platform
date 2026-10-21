/**
 * G03 — the last-admin refusal, in both languages, from both error classes,
 * keyed on the CODE only.
 */
import { describe, expect, it } from "vitest";
import { lastAdminRefusalToast } from "./lastAdminRefusal";

const en = (e: string) => e;
const ar = (_e: string, a: string) => a;
const SENTENCE = "Cannot remove the last admin of the organization.";
/** The generated client's error: the body under `.data`. */
const generated = (body: Record<string, unknown>) => Object.assign(new Error(`HTTP 409 Conflict: ${String(body.error)}`), { data: body });
/** `apiFetch`'s error. */
const fetched = (body: Record<string, unknown>) => Object.assign(new Error(String(body.error)), { code: body.code, body });

describe("G03 — the last-admin refusal", () => {
  it("🔴 titles and explains the refusal in both languages, from both clients, and names the next step", () => {
    for (const make of [generated, fetched]) {
      const err = make({ error: SENTENCE, code: "last_admin_required" });
      expect(lastAdminRefusalToast(err, en)).toEqual({
        title: "Not changed — the organization would have no admin",
        description: "An organization must keep at least one admin who can sign in. Make another member an admin first, then try again.",
        variant: "destructive",
      });
      const inArabic = lastAdminRefusalToast(err, ar)!;
      expect(inArabic.title).toBe("لم يتغيّر شيء — كانت المنظمة ستبقى بلا مسؤول");
      expect(inArabic.description).toMatch(/اجعل عضوًا آخر مسؤولًا أولًا/);
    }
  });

  it("is keyed on the CODE, not the words: the same sentence without the code, and another 409, are not this refusal", () => {
    expect(lastAdminRefusalToast(fetched({ error: SENTENCE }), en)).toBeNull();
    expect(lastAdminRefusalToast(fetched({ error: "Only drafts can be edited.", code: "not_draft" }), en)).toBeNull();
    expect(lastAdminRefusalToast(new Error("network"), en)).toBeNull();
  });
});
