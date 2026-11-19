import { Router } from "express";
import { journalEntriesController } from "../controllers/journalEntries.controller";
import { journalSourceReviewController } from "../controllers/journalSourceReview.controller";

const router = Router();

router.get("/", journalEntriesController.list);
// 🔴 A15 review (migration 0164): before `/:id`, which would otherwise read "unclassified" as an id.
router.get("/unclassified", journalSourceReviewController.list);
router.get("/:id", journalEntriesController.get);
router.post("/", journalEntriesController.create);
// Draft/approval workflow (M10.2): `approve` posts the draft to the GL; `reject`
// hard-deletes a pending draft. `post` is the JE-native alias for `approve`.
router.post("/:id/approve", journalEntriesController.approve);
router.post("/:id/reject", journalEntriesController.reject);
router.post("/:id/post", journalEntriesController.post);
router.post("/:id/reverse", journalEntriesController.reverse);
// 🔴 A15 review: an admin classifies an unclassified entry as a candidate the rules confirm now — never `manual`.
router.post("/:id/classify", journalSourceReviewController.classify);
router.delete("/:id", journalEntriesController.remove);

export default router;
