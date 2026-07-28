/**
 * Reports router — aggregates one module per report type. Each report's query
 * logic lives in repositories/reports.repository.ts and its computation in
 * services/reports.service.ts (behavior unchanged from the pre-M6 monolith).
 */
import { Router } from "express";
import trialBalance from "./trialBalance.js";
import incomeStatement from "./incomeStatement.js";
import balanceSheet from "./balanceSheet.js";
import cashFlow from "./cashFlow.js";
import journalReport from "./journalReport.js";
import generalLedger from "./generalLedger.js";
import accountStatement from "./accountStatement.js";
import accountSummary from "./accountSummary.js";
import customerLedger from "./customerLedger.js";
import ownerEquity from "./ownerEquity.js";
import arAging from "./arAging.js";
import apAging from "./apAging.js";
import taxJournalEntries from "./taxJournalEntries.js";
import activity from "./activity.js";
import vatReturn from "./vatReturn.js";

const router = Router();

router.use("/trial-balance", trialBalance);
router.use("/income-statement", incomeStatement);
router.use("/balance-sheet", balanceSheet);
router.use("/cash-flow", cashFlow);
router.use("/journal-report", journalReport);
router.use("/general-ledger", generalLedger);
router.use("/account-statement", accountStatement);
router.use("/account-summary", accountSummary);
router.use("/customer-ledger", customerLedger);
router.use("/owner-equity", ownerEquity);
router.use("/ar-aging", arAging);
router.use("/ap-aging", apAging);
router.use("/tax-journal-entries", taxJournalEntries);
router.use("/activity", activity);
router.use("/vat-return", vatReturn);

export default router;
