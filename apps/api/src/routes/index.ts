import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { resolveTenant } from "../lib/tenant";
import { requireAnyPermission, requirePermission } from "../lib/rbac";
import { requirePlatformOperator } from "../lib/operator";

// Route modules
import health from "./health.js";
import deployment from "./deployment.js";
import auth from "./auth.js";
import orgs from "./orgs.js";
import onboarding from "./onboarding.js";
import invitations from "./invitations.js";
import operator from "./operator.js";
import companies from "./companies.js";
import zatcaOnboarding from "./zatcaOnboarding.js";
import transactions from "./transactions.js";
import categories from "./categories.js";
import categorize from "./categorize.js";
import summary from "./summary.js";
import customers from "./customers.js";
import vendors from "./vendors.js";
import products from "./products.js";
import invoices from "./invoices.js";
import payments from "./payments.js";
import supplierPayments from "./supplierPayments.js";
import supplierStatements from "./supplierStatements.js";
import supplierCreditNotes from "./supplierCreditNotes.js";
import bankStatements from "./bankStatements.js";
import bankReconciliation from "./bankReconciliation.js";
import bankTransfers from "./bankTransfers.js";
import bankReconciliations from "./bankReconciliations.js";
import cashPosition from "./cashPosition.js";
import migration from "./migration.js";
import quotations from "./quotations.js";
import purchaseOrders from "./purchaseOrders.js";
import bills from "./bills.js";
import journalEntries from "./journalEntries.js";
import recognitionSchedules from "./recognitionSchedules.js";
import employees from "./employees.js";
import payroll from "./payroll.js";
import assets from "./assets.js";
import assetCategories from "./assetCategories.js";
import bankAccounts from "./bankAccounts.js";
import budgets from "./budgets.js";
import reports from "./reports/index.js";
import periodLocks from "./periodLocks.js";
import financeHub from "./financeHub.js";
import analytics from "./analytics.js";
import llm from "./llm.js";
import capture from "./capture.js";
import { refuseCaptureInDemo, refuseZatcaOnboardingInDemo } from "../lib/demoMode.js";
import recurring from "./recurring.js";
import approvals from "./approvals.js";
import findings from "./findings.js";
import ask from "./ask.js";
import auditLogs from "./auditLogs.js";

const router = Router();

// ── Public ──────────────────────────────────────────────────────────────────
router.use("/healthz", health);
// PUBLIC: the demo banner must render on the login page, before any session.
router.use("/deployment", deployment);
router.use("/auth", auth);
// Invitation preview/accept: PUBLIC + token-authenticated — the invitee may have
// no account and no tenant yet. All checks live in invitationsService.
router.use("/invitations", invitations);

// ── All remaining routes require a valid session ─────────────────────────────
router.use(requireAuth);

// ── Cross-organization endpoints (NOT tenant-scoped) ──────────────────────────
// Listing/switching organizations is inherently cross-org, so these run on the
// base connection BEFORE resolveTenant narrows the request to a single tenant.
router.use("/orgs", orgs);

// ── Onboarding / verification status (NOT tenant-scoped, NOT gated) ────────────
// Mounted before resolveTenant so a not-yet-approved org can still see its
// verification status (and later upload documents / resubmit). The verification
// gate lives in resolveTenant, so anything mounted here is reachable while pending.
router.use("/onboarding", onboarding);

// ── Platform-operator verification review (cross-tenant, operator-only) ────────
// Mounted before resolveTenant and guarded by requirePlatformOperator. Operators
// hold NO org membership, so resolveTenant would 403 them from every business
// route regardless; this surface returns ONLY verification metadata (never a
// tenant's financial data). Operator status is granted solely via the seed/CLI.
router.use("/operator", requirePlatformOperator, operator);

// ── Tenant context + RLS-scoped transaction for every business request ────────
// resolveTenant also enforces the VERIFICATION GATE: a non-approved org gets a
// 403 here (before the tenant transaction opens), so every business route below
// is fail-closed for unverified organizations.
router.use(resolveTenant);

// ── Centralized permission-based authorization (RBAC, M5) ─────────────────────
// Every business route is gated by requirePermission(resource): it reads the
// active-org role from req.tenant.role, infers the action from the HTTP method
// (GET→read, POST→create, PATCH/PUT→update, DELETE→delete), and checks it
// against the seeded role→resource→action mapping. Fail-closed. This replaces
// the old blanket method guard and the ad-hoc requireTenantRole guards.
router.use("/companies", requirePermission("companies"), companies);
router.use(
  "/zatca/onboarding",
  refuseZatcaOnboardingInDemo,
  requirePermission("zatca_onboarding"),
  zatcaOnboarding,
);
router.use("/transactions", requirePermission("transactions"), transactions);
// Phase 12A: statements are part of the transactions surface (the upload creates them).
router.use("/bank-statements", requirePermission("transactions"), bankStatements);
// Phase 12B: reconciling statement lines is the review of those lines — the same authority.
router.use("/bank-reconciliation", requirePermission("transactions"), bankReconciliation);
router.use("/bank-transfers", requirePermission("transactions"), bankTransfers);
// Phase 12D: a reconciliation as of a date is the same authority as the workbench; the cash position is a report.
router.use("/bank-reconciliations", requirePermission("transactions"), bankReconciliations);
router.use("/cash-position", requirePermission("reports"), cashPosition);
router.use("/categories", requirePermission("categories"), categories);
router.use("/summary", requirePermission("summary"), summary);
router.use("/customers", requirePermission("customers"), customers);
router.use("/vendors", requirePermission("vendors"), vendors);
router.use("/products", requirePermission("products"), products);
router.use("/invoices", requirePermission("invoices"), invoices);
router.use("/payments", requirePermission("payments"), payments);
// B3/B4: paying a supplier is a payment, so it carries the SAME authority as
// the customer side — one resource, not a second one nobody remembers to grant.
router.use("/supplier-payments", requirePermission("payments"), supplierPayments);
// B5: a supplier statement READS the AP subledger and the bills behind it;
// the bills grant is what decides who may see what a supplier is owed.
router.use("/supplier-statements", requirePermission("bills"), supplierStatements);
// B7: a purchase-side note IS a bill row, so it carries the bills authority.
router.use("/supplier-credit-notes", requirePermission("bills"), supplierCreditNotes);
router.use("/migration", requirePermission("migration"), migration);
router.use("/quotations", requirePermission("quotations"), quotations);
router.use("/purchase-orders", requirePermission("purchase_orders"), purchaseOrders);
router.use("/bills", requirePermission("bills"), bills);
router.use("/journal-entries", requirePermission("journal_entries"), journalEntries);
router.use("/recognition-schedules", requirePermission("journal_entries"), recognitionSchedules);
// Spans four resources: at least one READ grant to reach it, and the service
// then filters to exactly the entities this role may read.
router.use("/approvals", requireAnyPermission(["invoices", "bills", "journal_entries", "payroll"]), approvals);
router.use("/employees", requirePermission("employees"), employees);
router.use("/payroll", requirePermission("payroll"), payroll);
router.use("/assets", requirePermission("assets"), assets);
router.use("/asset-categories", requirePermission("assets"), assetCategories);
router.use("/bank-accounts", requirePermission("bank_accounts"), bankAccounts);
router.use("/budgets", requirePermission("budgets"), budgets);
router.use("/reports", requirePermission("reports"), reports);
router.use("/period-locks", requirePermission("period_locks"), periodLocks);
// M18.3 — read-only derived figures; gated on reports, which every role may read.
router.use("/finance-hub", requirePermission("reports"), financeHub);
router.use("/analytics", requirePermission("reports"), analytics);
router.use("/llm", requirePermission("llm"), llm);
// A capture becomes a vendor bill, so it carries the bills authority — one
// answer to "who may enter a purchase", not two.
router.use("/capture", refuseCaptureInDemo, requirePermission("bills"), capture);
router.use("/recurring", requirePermission("recurring"), recurring);
// AI-3a — deterministic internal-consistency findings; "findings", never "audit" (§9).
router.use("/findings", requirePermission("findings"), findings);
// AI-6a — grounded answers: register A (facts + projections), stored and auditable.
router.use("/ask", requirePermission("ask"), ask);
router.use("/audit-logs", requirePermission("audit_logs"), auditLogs);
router.use("/categorize", requirePermission("categorize"), categorize);

export default router;
