/**
 * 🔴 19B S1 — the routes that serve JSON OUTSIDE the contract, and the class of every key path each one serves.
 *
 * The contract (openapi.yaml) does not describe these routes (identity, membership, invitations, onboarding, the
 * operator surface, products, the company's bank accounts, the LLM status), so the seam cannot classify their keys
 * through it. Each is listed here by method and path template, and each key path it serves has a class:
 * `name`, `user.email`, `members[].email`, `[].id` for a list at the root, `$` for a whole plain value. A list of plain
 * values is one value. The test lane fails a response with a key path not listed here (seam.ts), exactly as it fails
 * an unclassified contract field.
 *
 * 🔴 THIS LIST CAN ONLY SHRINK. A route enters the contract and leaves this table in the same commit;
 * tests/field-class-table.test.ts pins the count, so a new route outside the contract is a deliberate act.
 */
import type { NodeClasses } from "./classTable";
import type { FieldLookup, ReadDecider, WalkResult, Withheld } from "./walk";
import { lastFour } from "./walk";
import { isPlainObject } from "./shapes";

const BANK_ACCOUNT_KEYS = [
  "id name bankName accountNumber iban currency balance ledgerBalance ledgerBalanceOnLeaf openingBalance openingJournalEntryId",
  "glAccountId glAccountName isActive isDefault notes attributedHistory organizationId companyId createdAt",
  // The company's OWN bank details and their held changes: business records, standard (v4 §5.2).
  "pendingBankDetailChanges[].id pendingBankDetailChanges[].kind pendingBankDetailChanges[].bankAccountId pendingBankDetailChanges[].vendorId",
  "pendingBankDetailChanges[].subjectName pendingBankDetailChanges[].ibanBefore pendingBankDetailChanges[].ibanAfter pendingBankDetailChanges[].status",
  "pendingBankDetailChanges[].requestedBy pendingBankDetailChanges[].requestedByName pendingBankDetailChanges[].requestedAt",
  "pendingBankDetailChanges[].decidedBy pendingBankDetailChanges[].decidedByName pendingBankDetailChanges[].decidedAt",
  // 19B S3: the held-change shape gained the employee kind and the fallback's reason (null for a bank account's change)
  "pendingBankDetailChanges[].employeeId pendingBankDetailChanges[].reason",
].join(" ");
const PRODUCT_KEYS = "id code name nameAr description type unit unitPrice unitCost currency vatApplicable stockQty reorderPoint categoryId isActive organizationId createdAt";
const APPLICATION_DECISION = { standard: "organizationId status reason" };
const MEMBERSHIP = { standard: "organizationId userId role status" };
/** A verification document's metadata (documents.repository.ts META, documents.service.ts _meta) — never its bytes. */
const DOCUMENT_META = "id organizationId type fileName mimeType sizeBytes uploadedByUserId createdAt";
const APPLICATION_HEADER = "organizationId name slug status reason reviewedBy reviewedAt submittedAt createdAt";
const prefixed = (prefix: string, keys: string) => keys.split(" ").map((k) => `${prefix}${k}`).join(" ");
/** An e-invoice outbox row as the operator sees it (operatorZatca.service.ts overdue / needsReview). */
const OUTBOX_ROW = "id organizationId companyId invoiceId flow status attemptCount ambiguous";

/**
 * Classified from the test lane's own traffic (2026-11-22, every API test, the capture in seam.ts). A route that shares
 * a presenter with a captured one carries the same keys (bank accounts, products by id, the operator's decisions).
 * A member's email, an invitation link and a temporary password are `member_security` (resource `users`), decided in
 * S2c; S1 serves them as before.
 */
export const OUTSIDE_CONTRACT_ROUTES: Record<string, NodeClasses> = {
  // ── identity (no organization role: decided in S2c; S1 withholds nothing here) ──
  "GET /auth/me": { resource: "users", standard: "id name role isActive createdAt organizationId organizationRole organizationVerificationStatus passwordChangeRequired mfaStep", member_security: "email" },
  "GET /auth/users": { resource: "users", standard: "[].id [].name [].role [].isActive [].createdAt", member_security: "[].email" },
  "PATCH /auth/users/{id}": { resource: "users", standard: "id name role isActive createdAt", member_security: "email" },
  "POST /auth/users/{id}/reset-password": { standard: "message" },
  "POST /auth/login": { resource: "users", standard: "message user.id user.name user.role user.isActive user.createdAt user.mfaStep user.passwordChangeRequired", member_security: "user.email" },
  "POST /auth/logout": { standard: "message" },
  "POST /auth/change-password": { standard: "message" },
  "POST /auth/register": { resource: "users", standard: "id name role membershipRole isActive createdAt organizationId", member_security: "email" },
  "POST /auth/signup": { resource: "users", standard: "organizationId verificationStatus user.id user.name user.role user.isActive", member_security: "user.email" },
  // ── membership and invitations ──
  "GET /orgs": { standard: "activeOrgId organizations[].organizationId organizations[].name organizations[].slug organizations[].role organizations[].verificationStatus" },
  "POST /orgs/switch": { standard: "activeOrgId" },
  "GET /orgs/{orgId}/members": { resource: "users", standard: "members[].userId members[].name members[].role members[].status members[].isActive", member_security: "members[].email" },
  "POST /orgs/{orgId}/members": MEMBERSHIP,
  "PATCH /orgs/{orgId}/members/{userId}": MEMBERSHIP,
  "DELETE /orgs/{orgId}/members/{userId}": MEMBERSHIP,
  // The list's rows are the repository's select (invitations.repository.ts listByOrg): no token material.
  "GET /orgs/{orgId}/invitations": { resource: "users", standard: "invitations[].id invitations[].role invitations[].status invitations[].expiresAt invitations[].acceptedAt invitations[].createdAt", member_security: "invitations[].email" },
  "POST /orgs/{orgId}/invitations": { resource: "users", standard: "id role status expiresAt emailDelivered", member_security: "email link" },
  "POST /orgs/{orgId}/invitations/{id}/resend": { resource: "users", standard: "id expiresAt emailDelivered", member_security: "email link" },
  "DELETE /orgs/{orgId}/invitations/{id}": { standard: "id status" },
  "GET /invitations/{token}": { resource: "users", standard: "organizationName role hasAccount expiresAt", member_security: "email" },
  "POST /invitations/{token}/accept": { resource: "users", standard: "organizationId role user.id user.name", member_security: "user.email" },
  // ── onboarding and the operator surface ──
  "GET /onboarding/status": { standard: "organizationId name status reason" },
  "GET /onboarding/documents": { standard: prefixed("documents[].", DOCUMENT_META) },
  "POST /onboarding/documents": { standard: DOCUMENT_META },
  "POST /onboarding/resubmit": APPLICATION_DECISION,
  "GET /operator/applications": { standard: prefixed("applications[].", APPLICATION_HEADER) },
  // The header, the applicant's companies, the review history (verification_reviews' whole row) and the documents'
  // metadata (verification.repository.ts, documents.repository.ts).
  "GET /operator/applications/{orgId}": {
    standard: [
      APPLICATION_HEADER,
      "companies[].id companies[].name companies[].crNumber companies[].vatNumber",
      prefixed("reviews[].", "id organizationId operatorUserId fromStatus toStatus reason createdAt"),
      prefixed("documents[].", DOCUMENT_META),
    ].join(" "),
  },
  "POST /operator/applications/{orgId}/approve": APPLICATION_DECISION,
  "POST /operator/applications/{orgId}/reject": APPLICATION_DECISION,
  "POST /operator/applications/{orgId}/reopen": APPLICATION_DECISION,
  "POST /operator/applications/{orgId}/request-info": APPLICATION_DECISION,
  "POST /operator/users/reset-password": { resource: "users", standard: "name sessionsRevoked guidance", member_security: "email temporaryPassword" },
  "POST /operator/zatca/jobs/{name}/run": { standard: "job result.scanned result.archived result.skipped result.failed" },
  // ── the company's own bank accounts, and products ──
  "GET /bank-accounts": { standard: BANK_ACCOUNT_KEYS.split(" ").map((k) => `[].${k}`).join(" ") },
  "GET /bank-accounts/{id}": { standard: BANK_ACCOUNT_KEYS },
  "POST /bank-accounts": { standard: BANK_ACCOUNT_KEYS },
  "PATCH /bank-accounts/{id}": { standard: BANK_ACCOUNT_KEYS },
  "GET /products/{id}": { standard: PRODUCT_KEYS },
  "POST /products": { standard: PRODUCT_KEYS },
  "PATCH /products/{id}": { standard: PRODUCT_KEYS },
  // ── 2026-11-22 (owner, item 6): the routes S1's measurement left unreached, now reached by
  // tests/field-class-unreached-routes.test.ts. Item keys of a list the test leaves empty are the service's own
  // projection (operatorZatca.service.ts), read from the code.
  "GET /products": { standard: [prefixed("items[].", PRODUCT_KEYS), "page.limit page.offset page.total totals.productCount totals.serviceCount totals.vatApplicableCount"].join(" ") },
  "GET /llm/status": { standard: "activModel llmBackendConfigured mode model note reachable" },
  "GET /llm/demo": { standard: "activeModel note summary.agreed summary.disagreed summary.total transactions[].amount transactions[].description transactions[].type transactions[].match transactions[].deterministic.category transactions[].deterministic.confidence transactions[].deterministic.rule transactions[].hybrid.category transactions[].hybrid.confidence transactions[].hybrid.model transactions[].hybrid.source" },
  // The caller's own input, echoed (no stored record is read).
  "POST /llm/categorize": { standard: "categoryName categoryNameAr confidence matchedRule source suggestedVatRate systemCode vatApplicable" },
  "POST /llm/compare": { standard: "agreed agreementRate disagreed model total results[].agreement results[].input.amount results[].input.description results[].input.type results[].deterministic results[].deterministic.categoryName results[].deterministic.confidence results[].deterministic.matchedRule results[].hybrid.categoryName results[].hybrid.confidence results[].hybrid.llmModel results[].hybrid.matchedRule results[].hybrid.source" },
  // The operator's ZATCA views: operational metadata — never a tenant's figures, XML or keys.
  "GET /operator/zatca/health": { standard: "overdueMinutes needsReview workerEnabled overdue.total overdue.breakdownCoversFirst overdue.oldestAgeMinutes overdue.byFlow.clearance overdue.byFlow.reporting archive.archived archive.pendingArchive" },
  "GET /operator/zatca/overdue": { standard: prefixed("[].", OUTBOX_ROW) },
  "GET /operator/zatca/needs-review": { standard: prefixed("[].", OUTBOX_ROW) },
  "GET /operator/zatca/certificates": { standard: prefixed("[].", "credentialId companyId companyName organizationId environment notAfter daysRemaining expired remindersRaised remindersMissing") },
  "GET /operator/zatca/onboarding": { standard: [prefixed("items[].", "companyId companyName organizationId organizationName hasVatNumber egsSerialNumber environment credentialStatus notAfter readyToOnboard"), "page.limit page.offset page.total"].join(" ") },
};

// isPlainObject: one definition (shapes.ts) — a Date is one value, never an object to walk into.
const REMOVE = Symbol("withheld");

/** The key paths a value serves, as the table names them (for building and checking the table). */
export function keyPathsOf(value: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      if (v.length === 0) return; // an empty list serves no value
      if (v.some((x) => isPlainObject(x) || Array.isArray(x))) for (const x of v) visit(x, `${path}[]`);
      else out.add(path || "$");
      return;
    }
    if (isPlainObject(v)) {
      for (const [k, x] of Object.entries(v)) visit(x, path ? `${path}.${k}` : k);
      return;
    }
    out.add(path || "$");
  };
  visit(value, "");
  return [...out];
}

/** The walk for a route outside the contract: each key path's class from the route's own entry. */
export function walkStructural(value: unknown, routeKey: string, lookup: FieldLookup, decide: ReadDecider, denyUnclassified = false): WalkResult {
  const withheld: Withheld[] = [];
  const unclassified = new Set<string>();
  const leaf = (v: unknown, path: string): unknown => {
    const key = path || "$";
    const spec = lookup(routeKey, key);
    if (!spec) {
      unclassified.add(`${routeKey}.${key}`);
      // default deny (v4 §5.3): removed and listed, instead of served
      if (!denyUnclassified) return v;
      withheld.push({ path: key, class: "unclassified", level: "none" });
      return REMOVE;
    }
    if (spec.cls === "standard" || spec.cls === "by_entity") return v;
    if (!spec.resource) throw new Error(`outside-contract table: ${routeKey} ${key} is ${spec.cls} but names no resource`);
    const level = decide(spec.cls, spec.resource);
    if (level === "read") return v;
    if (level === "last4" && spec.cls === "bank_account" && (v === null || typeof v === "string")) {
      if (v === null) return v;
      withheld.push({ path: key, class: spec.cls, level: "last4" });
      return lastFour(v);
    }
    withheld.push({ path: key, class: spec.cls, level: "none" });
    return REMOVE;
  };
  const visit = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) {
      if (v.length === 0) return v;
      if (!v.some((x) => isPlainObject(x) || Array.isArray(x))) return leaf(v, path);
      let out: unknown[] | null = null;
      v.forEach((x, i) => {
        const next = visit(x, `${path}[]`);
        if (next === REMOVE) throw new Error(`walk: a list item at ${path}[] cannot be withheld alone`);
        if (next !== x) (out ??= v.slice())[i] = next;
      });
      return out ?? v;
    }
    if (isPlainObject(v)) {
      let out: Record<string, unknown> | null = null;
      for (const [k, x] of Object.entries(v)) {
        const next = visit(x, path ? `${path}.${k}` : k);
        if (next === REMOVE) {
          out ??= { ...v };
          delete out[k];
        } else if (next !== x) (out ??= { ...v })[k] = next;
      }
      return out ?? v;
    }
    return leaf(v, path);
  };
  let value2 = visit(value, "");
  if (value2 === REMOVE) value2 = null;
  return { value: value2, withheld, unclassified: [...unclassified] };
}
