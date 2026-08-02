import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { resolveTenant } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";

// Route modules
import health from "./health.js";
import auth from "./auth.js";
import orgs from "./orgs.js";
import onboarding from "./onboarding.js";
import transactions from "./transactions.js";
import categories from "./categories.js";
import categorize from "./categorize.js";
import summary from "./summary.js";
import customers from "./customers.js";
import vendors from "./vendors.js";
import products from "./products.js";
import invoices from "./invoices.js";
import bills from "./bills.js";
import journalEntries from "./journalEntries.js";
import employees from "./employees.js";
import payroll from "./payroll.js";
import assets from "./assets.js";
import bankAccounts from "./bankAccounts.js";
import budgets from "./budgets.js";
import reports from "./reports/index.js";
import periodLocks from "./periodLocks.js";
import llm from "./llm.js";
import auditLogs from "./auditLogs.js";

const router = Router();

// ── Public ──────────────────────────────────────────────────────────────────
router.use("/healthz", health);
router.use("/auth", auth);

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
router.use("/transactions", requirePermission("transactions"), transactions);
router.use("/categories", requirePermission("categories"), categories);
router.use("/summary", requirePermission("summary"), summary);
router.use("/customers", requirePermission("customers"), customers);
router.use("/vendors", requirePermission("vendors"), vendors);
router.use("/products", requirePermission("products"), products);
router.use("/invoices", requirePermission("invoices"), invoices);
router.use("/bills", requirePermission("bills"), bills);
router.use("/journal-entries", requirePermission("journal_entries"), journalEntries);
router.use("/employees", requirePermission("employees"), employees);
router.use("/payroll", requirePermission("payroll"), payroll);
router.use("/assets", requirePermission("assets"), assets);
router.use("/bank-accounts", requirePermission("bank_accounts"), bankAccounts);
router.use("/budgets", requirePermission("budgets"), budgets);
router.use("/reports", requirePermission("reports"), reports);
router.use("/period-locks", requirePermission("period_locks"), periodLocks);
router.use("/llm", requirePermission("llm"), llm);
router.use("/audit-logs", requirePermission("audit_logs"), auditLogs);
router.use("/categorize", requirePermission("categorize"), categorize);

export default router;
