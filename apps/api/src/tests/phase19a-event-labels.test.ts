/**
 * 🔴 Phase 19A (19.8): the vocabulary of security events 19A's acts write is ONE list (services/securityAudit.service.ts
 * `PHASE19A_SECURITY_EVENTS`), and the screen that reads the trail labels every one of them in English AND Arabic
 * (components/SecurityEventsCard.tsx). Two definitions of one fact with no forcing function diverge invisibly — this is
 * the forcing function. Source text only; no database.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "..", "..");
const service = readFileSync(join(root, "apps/api/src/services/securityAudit.service.ts"), "utf8");
const card = readFileSync(join(root, "apps/web/src/components/SecurityEventsCard.tsx"), "utf8");

function vocabulary(): string[] {
  const m = service.match(/export const PHASE19A_SECURITY_EVENTS = \[([\s\S]*?)\] as const;/);
  return m ? [...m[1]!.matchAll(/"([a-z_.]+)"/g)].map((x) => x[1]!) : [];
}

describe("Phase 19A — the security-event vocabulary and its labels are one list", () => {
  it("🔴 the vocabulary is declared, and names every 19A act (sessions, MFA, settings)", () => {
    const v = vocabulary();
    expect(v).toEqual(expect.arrayContaining([
      "session.revoked", "session.revoked_all", "mfa.enrolled", "mfa.activated", "mfa.verified", "mfa.failed",
      "mfa.recovery_code_used", "mfa.reset", "security_settings.changed",
    ]));
  });

  it("🔴 every event in it is labelled on the trail's screen, in English and in Arabic", () => {
    const v = vocabulary();
    expect(v.length, "anti-vacuity: the vocabulary is not empty").toBeGreaterThan(0);
    const missing = v.filter((action) => {
      const m = card.match(new RegExp(`"${action.replace(/\./g, "\\.")}": \\["([^"]+)", "([^"]+)"\\]`));
      return !m || !/[؀-ۿ]/.test(m[2]!) || /[؀-ۿ]/.test(m[1]!);
    });
    expect(missing).toEqual([]);
  });
});
