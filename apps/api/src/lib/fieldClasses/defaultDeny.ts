/**
 * 🔴 19B (v4 §5.3) — DEFAULT DENY: the switch, and who it applies to. ON BY DEFAULT (owner, 2026-11-26).
 *
 * The rule: a served field with NO class — a key the contract and the outside-contract table cannot classify — is
 * removed for every non-admin and listed as `unclassified`. `standard` is a class a field is GIVEN, never a default
 * (classTable.ts), so a field nobody classified is not `standard`: it is unknown, and unknown is not served on trust.
 *
 * 🔴 ON BY DEFAULT (owner, 2026-11-26: "make it ON by default in code, so CI's API and browser suites run with it").
 * `FIELD_DEFAULT_DENY` defaults to `on` and nothing in the repository sets it. `off` stays a value the setting accepts.
 *
 * 🔴 IN THE TEST LANE the seam does not use it to hide anything: under NODE_ENV=test an unclassified key is a 500
 * `field_unclassified`, by name, for every role (seam.ts) — a missing class fails the test that served it, as it always
 * has. A test that wants to see the enforcement itself forces it (`__setDefaultDenyForTests(true)`): the canary
 * sweep's per-role report does, and so does tests/default-deny.test.ts.
 *
 * WHO: every organization role except the admin (v4 §5.1: no class = withheld from every role except admin). A request
 * with no organization role — identity, onboarding, the operator surface — is not denied: those routes answer before a
 * role exists, and denying them would deny sign-in itself.
 */
import { loadEnv } from "@workspace/config";

let override: boolean | null = null;

/** Whether default deny is switched on in this process. */
export function defaultDenyOn(): boolean {
  return override ?? loadEnv().FIELD_DEFAULT_DENY === "on";
}

/** Whether an unclassified field is withheld from this reader (when the switch is on). */
export function defaultDeniesRole(role: string | undefined): boolean {
  return !!role && role !== "admin";
}

/** Whether a test has forced the switch (so the seam shows the enforcement instead of the test lane's 500). */
export function defaultDenyForcedForTests(): boolean {
  return override !== null;
}

/** Test-only: force the switch (`null` returns it to the environment's setting). */
export function __setDefaultDenyForTests(value: boolean | null): void {
  override = value;
}
