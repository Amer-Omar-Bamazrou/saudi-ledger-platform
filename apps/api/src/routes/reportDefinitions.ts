import { Router, type Request } from "express";
import { hasFor, withReportError } from "../controllers/reports.controller";
import { BusinessRuleError } from "../lib/errors";
import { reportDefinitionsService, type DefinitionActor } from "../services/reporting/reportDefinitions.service";

/**
 * 🔴 19B S6 — saved report definitions (v4 §4, §6.2). Mounted behind `read` on `reports`, which every role holds; what
 * a role may then DO is the dataset's own act grant (`save`, `share`), asked of `decide()` in the service — the method
 * is not the permission here, the act is.
 */
const router = Router();

const actor = (req: Request): DefinitionActor => {
  const t = req.tenant!;
  if (t.userId == null) throw new BusinessRuleError(403, { code: "report_member_required", error: "Sign in as a member to use saved reports.", errorAr: "سجّل الدخول كعضو لاستخدام التقارير المحفوظة." });
  return { userId: t.userId, organizationId: t.organizationId, companyId: t.companyId, role: t.role };
};
const id = (req: Request) => Number(req.params.id);

router.get("/", withReportError(async (req, res) => { res.json(await reportDefinitionsService.list(actor(req), hasFor(req))); }));
router.post("/", withReportError(async (req, res) => { res.status(201).json(await reportDefinitionsService.create(req.body, actor(req), hasFor(req))); }));
router.get("/:id", withReportError(async (req, res) => { res.json(await reportDefinitionsService.get(id(req), actor(req), hasFor(req))); }));
router.put("/:id", withReportError(async (req, res) => { res.json(await reportDefinitionsService.update(id(req), req.body, actor(req), hasFor(req))); }));
router.put("/:id/share", withReportError(async (req, res) => { res.json(await reportDefinitionsService.share(id(req), req.body, actor(req), hasFor(req))); }));
router.delete("/:id", withReportError(async (req, res) => { await reportDefinitionsService.archive(id(req), actor(req), hasFor(req)); res.status(204).end(); }));

export default router;
