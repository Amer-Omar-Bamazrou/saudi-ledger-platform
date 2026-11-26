import { Router } from "express";
import { hasFor, withReportError } from "../controllers/reports.controller";
import { reportSchedulesService } from "../services/reporting/reportSchedules.service";
import { reportDeliveriesService } from "../services/reporting/reportDeliveries.service";
import { reportActor } from "./reportDefinitions";

/**
 * 🔴 19B S6 — report schedules, and the stored copies they deliver (v4 §6.2, §9). Both mounted behind `read` on
 * `reports`; what a role may DO is the dataset's own act grant (`schedule`, `deliver`, and `run` at every open), asked
 * of `decide()` in the services.
 */
export const reportSchedulesRouter = Router();
reportSchedulesRouter.get("/", withReportError(async (req, res) => { res.json(await reportSchedulesService.list(reportActor(req))); }));
// before `/:id`: the members a report can be delivered to — names and roles only
reportSchedulesRouter.get("/recipients", withReportError(async (req, res) => { res.json(await reportSchedulesService.recipients(reportActor(req))); }));
reportSchedulesRouter.post("/", withReportError(async (req, res) => { res.status(201).json(await reportSchedulesService.create(req.body, reportActor(req), hasFor(req))); }));
reportSchedulesRouter.delete("/:id", withReportError(async (req, res) => { await reportSchedulesService.end(Number(req.params.id), reportActor(req)); res.status(204).end(); }));

/** The one path to a stored copy: its recipient, with their grants re-checked at every open. No write route exists. */
export const reportDeliveriesRouter = Router();
reportDeliveriesRouter.get("/", withReportError(async (req, res) => { res.json(await reportDeliveriesService.list(reportActor(req))); }));
reportDeliveriesRouter.get("/:id", withReportError(async (req, res) => {
  // never cached: a copy is report data, and what the reader may see of it is decided at each open
  res.setHeader("Cache-Control", "no-store");
  res.json(await reportDeliveriesService.open(Number(req.params.id), reportActor(req), hasFor(req)));
}));
