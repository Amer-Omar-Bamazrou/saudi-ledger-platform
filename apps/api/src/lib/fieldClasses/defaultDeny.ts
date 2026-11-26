/**
 * 🔴 19B (v4 §5.3) — DEFAULT DENY: the switch, and who it applies to. PREPARED, AND OFF.
 *
 * The rule: a served field with NO class — a key the contract and the outside-contract table cannot classify — is
 * removed for every non-admin and listed as `unclassified`. `standard` is a class a field is GIVEN, never a default
 * (classTable.ts), so a field nobody classified is not `standard`: it is unknown, and unknown is not served on trust.
 *
 * 🔴 OFF until the owner approves (owner, 2026-11-26: "prepare it, but don't switch it on"). `FIELD_DEFAULT_DENY`
 * defaults to `off`, nothing in the repository sets it, and with it off the response seam does exactly what it did
 * before this file existed. Switching it on is an environment change, made with the owner's approval per environment
 * after reading the dry run (tests/field-class-canary-sweep.test.ts, "default deny, a dry run").
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

/** Test-only: force the switch (`null` returns it to the environment's setting). */
export function __setDefaultDenyForTests(value: boolean | null): void {
  override = value;
}
