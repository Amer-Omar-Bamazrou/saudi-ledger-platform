/** 🔴 T1e (DR-10, DR-30): a fiscal year's statements authorised for issue — recorded and read, never changed. */
import { Router } from "express";
import { periodRecordsController } from "../controllers/periodRecords.controller";

const router = Router();

router.get("/", periodRecordsController.authorisations);
router.post("/", periodRecordsController.recordAuthorisation);

export default router;
