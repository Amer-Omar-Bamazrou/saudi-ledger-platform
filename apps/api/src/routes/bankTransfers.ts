import { Router } from "express";
import { bankTransfersController } from "../controllers/bankTransfers.controller";

/**
 * Phase 12C — transfers between the business's own banks. `create` and
 * `reverse` post (one entry each, through the one posting path); nothing
 * else here writes.
 */
const router = Router();

router.get("/", bankTransfersController.list);
router.post("/", bankTransfersController.create);
router.get("/:id", bankTransfersController.get);
router.post("/:id/reverse", bankTransfersController.reverse);

export default router;
