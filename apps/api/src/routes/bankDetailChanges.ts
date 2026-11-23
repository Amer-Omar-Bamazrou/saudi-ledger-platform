/**
 * 🔴 19B S3 (v4 §6.3, D2) — the held bank-detail changes, mounted at `/companies/current/bank-detail-changes` behind
 * `requirePermission("bank_detail")` (routes/index.ts, BEFORE the `companies` mount): the list needs `read`; the
 * decision (`PUT …/decision`) resolves to `approve` (lib/rbac.ts) — an accountant or an admin. The database decides
 * again who may approve which kind (0170): a supplier's or employee's IBAN by a `bank_detail:approve` holder who is not
 * the requester; the company's own bank accounts by a second usable admin (DR-23).
 */
import { Router } from "express";
import { companiesController } from "../controllers/companies.controller";

const router = Router();
router.get("/", companiesController.bankDetailChanges);
router.put("/:id/decision", companiesController.decideBankDetailChange);
export default router;
