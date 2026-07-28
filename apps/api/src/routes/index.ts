import { Router } from "express";
import { requireAuth, requireTenantRole } from "../lib/auth";
import { resolveTenant } from "../lib/tenant";

// Route modules
import health from "./health.js";
import auth from "./auth.js";
import orgs from "./orgs.js";
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
import reports from "./reports.js";
import periodLocks from "./periodLocks.js";
import llm from "./llm.js";

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

// ── Tenant context + RLS-scoped transaction for every business request ────────
router.use(resolveTenant);

// ── Method-level role guard (role sourced from the active membership) ─────────
// DELETE → Admin only
// POST / PATCH / PUT → Accountant or Admin
// GET → any authenticated role (viewer, accountant, admin)
router.use((req, res, next) => {
  const role = req.tenant?.role;
  if (req.method === "DELETE" && role !== "admin") {
    res.status(403).json({ error: "Only admins can delete records." }); return;
  }
  if (["POST", "PATCH", "PUT"].includes(req.method) && role === "viewer") {
    res.status(403).json({ error: "Viewers have read-only access." }); return;
  }
  next();
});

// ── Read routes — any authenticated role (viewer, accountant, admin) ─────────
router.use("/transactions", transactions);
router.use("/categories", categories);
router.use("/summary", summary);
router.use("/customers", customers);
router.use("/vendors", vendors);
router.use("/products", products);
router.use("/invoices", invoices);
router.use("/bills", bills);
router.use("/journal-entries", journalEntries);
router.use("/employees", employees);
router.use("/payroll", payroll);
router.use("/assets", assets);
router.use("/bank-accounts", bankAccounts);
router.use("/budgets", budgets);
router.use("/reports", reports);
router.use("/period-locks", periodLocks);
router.use("/llm", llm);

// ── Mutation-heavy sub-routes are further guarded inside their handlers ───────
// (Accountant/Admin guards are applied per-verb in each route file for
//  POST/PATCH/DELETE. Viewer-only users can read but not write.)
router.use("/categorize", requireTenantRole("admin", "accountant"), categorize);

export default router;
