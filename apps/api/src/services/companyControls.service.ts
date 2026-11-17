/**
 * 🔴 Phase 18 H-9 — a company's CONTROL SETTINGS (DR-19, DR-21) and DR-23's
 * "payment soon after a bank-detail change" finding. Each DECIDED 2026-10-27 —
 * owner accepted the stated recommendation (register §11.56).
 *
 * DR-19: the settings are a TYPED table (`company_control_settings`), one
 * column per control, so a misspelt key or a wrong-typed value cannot be
 * stored. DR-21: every slot starts EMPTY — null, its control disabled — and no
 * default number exists anywhere. The finding asks the slot, and while it is
 * empty answers "disabled" with no items; it never applies a number of its own.
 *
 * DR-23's finding is read-only and deterministic. A supplier's bank-detail
 * change is the audit trail's vendor update record whose before and after IBAN
 * differ (every vendor update writes one; H-8 checks the IBAN itself), dated on
 * the business day it was recorded. Each payment to that supplier in this
 * company — a bill payment or a supplier payment — dated on, or within N days
 * after, the latest change it follows is listed once.
 */
import { businessDate, businessDateShift } from "@workspace/shared";
import { BadRequestError } from "../lib/errors";
import { companyControlsRepository } from "../repositories/companyControls.repository";
import { auditService } from "./audit.service";

/** The window's bound, as the table's CHECK states it. */
const MAX_WINDOW_DAYS = 365;

export type ControlSettings = { bankChangePaymentWindowDays: number | null };

export type PaymentAfterBankChangeItem = {
  kind: "bill_payment" | "supplier_payment";
  paymentId: number;
  billId: number | null;
  vendorId: number;
  vendorName: string;
  amount: number;
  paidAt: string;
  changedOn: string;
  /** The instant the payment was recorded (ISO). */
  recordedAt: string;
  /** Owner A23: which fell inside the window after the change — the payment's date, its recording time, or both. */
  matchedBy: "date" | "recorded" | "both";
};

const DAY_MS = 24 * 60 * 60 * 1000;

function windowDaysOf(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_WINDOW_DAYS) {
    throw new BadRequestError(
      `bankChangePaymentWindowDays is a whole number of days from 1 to ${MAX_WINDOW_DAYS}, or null to leave the finding disabled.`,
    );
  }
  return value;
}

async function settings(): Promise<ControlSettings> {
  const row = await companyControlsRepository.get();
  return { bankChangePaymentWindowDays: row?.bankChangePaymentWindowDays ?? null };
}

export const companyControlsService = {
  settings,

  /** Admin only (the route's permission). A change is recorded with its before and after values; an unchanged value writes nothing. */
  async updateSettings(body: { bankChangePaymentWindowDays?: unknown }, userId: number | null): Promise<ControlSettings> {
    if (!("bankChangePaymentWindowDays" in body)) {
      throw new BadRequestError("bankChangePaymentWindowDays is required: a number of days from 1 to 365, or null.");
    }
    const next = windowDaysOf(body.bankChangePaymentWindowDays);
    const before = await settings();
    if (before.bankChangePaymentWindowDays === next) return before;
    const row = await companyControlsRepository.upsert({ bankChangePaymentWindowDays: next, updatedBy: userId });
    const after: ControlSettings = { bankChangePaymentWindowDays: row.bankChangePaymentWindowDays };
    await auditService.updated("company_control_settings", row.id, before, after);
    return after;
  },

  async paymentAfterBankChange(): Promise<{ enabled: boolean; windowDays: number | null; items: PaymentAfterBankChangeItem[] }> {
    const { bankChangePaymentWindowDays: windowDays } = await settings();
    if (windowDays == null) return { enabled: false, windowDays: null, items: [] };

    /*
     * 🔴 Owner decision A23 (2026-11-16): the window after a change is read on BOTH clocks, and either lists the payment.
     *   - the change: its instant T and its business day D = businessDate(T) (Asia/Riyadh seam);
     *   - by DATE:      D <= the payment's date <= D + N calendar days (both ends inclusive);
     *   - by RECORDING: T <= the payment's recording instant <= T + N x 24 h (both ends inclusive).
     * Each measures from the LATEST change at or before it on its own clock — the nearest, so if that one is outside
     * the window every earlier one is too. A back-dated payment (recorded after the change, dated before it) used to
     * escape the date-only reading (the audit's A23).
     */
    const changes = new Map<number, Array<{ ms: number; day: string }>>(); // each supplier's changes, ascending
    for (const c of await companyControlsRepository.vendorIbanChanges()) {
      const vendorId = Number(c.entityId);
      if (!Number.isInteger(vendorId)) continue;
      const ms = Number(c.ms);
      const list = changes.get(vendorId) ?? [];
      list.push({ ms, day: businessDate(new Date(ms)) });
      changes.set(vendorId, list);
    }
    if (changes.size === 0) return { enabled: true, windowDays, items: [] };

    const all = [...changes.values()].flat();
    const earliestDay = all.map((c) => c.day).sort()[0]!;
    const earliestMs = Math.min(...all.map((c) => c.ms));
    const items: PaymentAfterBankChangeItem[] = [];
    for (const p of await companyControlsRepository.paymentsToVendors([...changes.keys()], earliestDay, earliestMs)) {
      const mine = changes.get(p.vendorId) ?? [];
      const byDate = mine.filter((c) => c.day <= p.paidAt).pop();
      const dateInside = byDate != null && p.paidAt <= businessDateShift(byDate.day, windowDays);
      const byRecording = mine.filter((c) => c.ms <= p.recordedMs).pop();
      const recordedInside = byRecording != null && p.recordedMs <= byRecording.ms + windowDays * DAY_MS;
      if (!dateInside && !recordedInside) continue;
      const { recordedMs, ...row } = p;
      items.push({
        ...row,
        amount: Number(p.amount),
        changedOn: (dateInside ? byDate! : byRecording!).day,
        recordedAt: new Date(recordedMs).toISOString(),
        matchedBy: dateInside && recordedInside ? "both" : dateInside ? "date" : "recorded",
      });
    }
    items.sort((a, b) => b.paidAt.localeCompare(a.paidAt) || a.kind.localeCompare(b.kind) || b.paymentId - a.paymentId);
    return { enabled: true, windowDays, items };
  },
};
