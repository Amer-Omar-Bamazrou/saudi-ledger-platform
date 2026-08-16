/**
 * Demo-mode refusals (docs/product/demo-deployment-decisions.md).
 *
 * 🔴 These turn capabilities OFF. They weaken no production guard —
 * `NODE_ENV=production` still refuses local-dev KMS, `MAIL_PROVIDER=none` and
 * `ALERT_PROVIDER=none`, and the demo satisfies all three truthfully (D1/D2).
 *
 * The refusal is SERVER-SIDE and route-level on purpose. Hiding a button is a
 * suggestion; a 403 from the route is what actually holds when someone opens
 * the network tab — and a demo URL is public.
 */
import type { Request, Response, NextFunction } from "express";
import { loadEnv } from "@workspace/config";

/**
 * Refuse a capability a demo deployment must not have.
 *
 * The reason is returned to the caller, because a bare 403 on a public demo
 * reads as a bug in the product being demonstrated — the opposite of the point.
 */
export function refuseInDemo(reason: string) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!loadEnv().DEMO_MODE) return next();
    res.status(403).json({ error: reason, code: "demo_mode" });
  };
}

/**
 * D3 — the one place a demo could do IRREVERSIBLE harm.
 *
 * PDPL is unanswered (queue C8) and a promoted capture lands in a store with no
 * `delete` by design. A public demo inviting people to photograph real supplier
 * invoices is off not because it would break, but because it would work.
 */
export const refuseCaptureInDemo = refuseInDemo(
  "Document capture is switched off in this demo. Photographs of real documents can contain " +
    "other people's personal data, and a posted capture is retained permanently by design — " +
    "so a demo does not accept them.",
);

/**
 * D5 — ZATCA off, at the point where a demo could START holding real key
 * material.
 *
 * `DEMO_MODE` already refuses `ZATCA_WORKER_ENABLED` at boot, so nothing can be
 * transmitted. This closes the other half: onboarding takes a CSR and an OTP
 * from a REAL taxpayer's Fatoora portal and stores a wrapped private key. A
 * public demo must not accept that at all — not because the vault would fail,
 * but because it would work, and the demo's whole premise is a fictional
 * company.
 */
export const refuseZatcaOnboardingInDemo = refuseInDemo(
  "ZATCA onboarding is switched off in this demo. It would take a real taxpayer's credentials " +
    "and store a real signing key, and this deployment is a fictional company with a deliberately " +
    "invalid VAT number.",
);

/** D4 — one shared login; no self-service tenants on a public URL. */
export const refuseSignupInDemo = refuseInDemo(
  "Sign-up is switched off in this demo. It runs as a single shared account with sample data.",
);
