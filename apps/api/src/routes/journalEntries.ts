import { Router } from "express";
import { journalEntriesController } from "../controllers/journalEntries.controller";

const router = Router();

router.get("/", journalEntriesController.list);
router.get("/:id", journalEntriesController.get);
router.post("/", journalEntriesController.create);
// Draft/approval workflow (M10.2): `approve` posts the draft to the GL; `reject`
// hard-deletes a pending draft. `post` is the JE-native alias for `approve`.
router.post("/:id/approve", journalEntriesController.approve);
router.post("/:id/reject", journalEntriesController.reject);
router.post("/:id/post", journalEntriesController.post);
router.post("/:id/reverse", journalEntriesController.reverse);
router.delete("/:id", journalEntriesController.remove);

export default router;
