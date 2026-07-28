import { Router } from "express";
import { journalEntriesController } from "../controllers/journalEntries.controller";

const router = Router();

router.get("/", journalEntriesController.list);
router.get("/:id", journalEntriesController.get);
router.post("/", journalEntriesController.create);
router.post("/:id/post", journalEntriesController.post);
router.post("/:id/reverse", journalEntriesController.reverse);
router.delete("/:id", journalEntriesController.remove);

export default router;
