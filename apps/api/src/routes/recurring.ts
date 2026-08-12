/**
 * Recurring rules (A3).
 *
 * Mounted behind `requirePermission("recurring")`. A rule creates DRAFTS, so it
 * is create-level authority — a bookkeeper may set up a monthly retainer, and
 * the draft it produces still needs an approver, exactly as if they had typed it.
 */
import { Router } from "express";
import { BadRequestError } from "../lib/errors";
import { recurringService } from "../services/recurring/recurring.service";

const router = Router();

router.get("/", async (_req, res) => {
  res.json(await recurringService.list());
});

router.post("/", async (req, res) => {
  const b = req.body ?? {};
  if (!b.template || typeof b.template !== "object") {
    throw new BadRequestError("template is required — the document this rule repeats");
  }
  res.status(201).json(
    await recurringService.create(
      {
        entity: b.entity,
        template: b.template,
        frequency: b.frequency,
        dayOfMonth: Number(b.dayOfMonth),
        startsOn: String(b.startsOn ?? ""),
        endsOn: b.endsOn ?? null,
        autoIssue: !!b.autoIssue,
      },
      { userId: req.session?.userId ?? null, role: req.tenant?.role ?? null },
    ),
  );
});

/** The run history — "did my rent invoice go out?" */
router.get("/:id/runs", async (req, res) => {
  res.json(await recurringService.runs(req.params.id));
});

router.post("/:id/pause", async (req, res) => {
  res.json(await recurringService.pause(req.params.id, true));
});

router.post("/:id/resume", async (req, res) => {
  res.json(await recurringService.pause(req.params.id, false));
});

router.delete("/:id", async (req, res) => {
  await recurringService.remove(req.params.id);
  res.status(204).end();
});

export default router;
