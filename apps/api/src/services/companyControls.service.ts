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
};

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

    // each supplier's change days, ascending
    const changes = new Map<number, string[]>();
    for (const c of await companyControlsRepository.vendorIbanChanges()) {
      const vendorId = Number(c.entityId);
      if (!Number.isInteger(vendorId)) continue;
      const day = businessDate(c.createdAt);
      const days = changes.get(vendorId) ?? [];
      if (days[days.length - 1] !== day) days.push(day);
      changes.set(vendorId, days);
    }
    if (changes.size === 0) return { enabled: true, windowDays, items: [] };

    const earliest = [...changes.values()].map((d) => d[0]).sort()[0];
    const items: PaymentAfterBankChangeItem[] = [];
    for (const p of await companyControlsRepository.paymentsToVendors([...changes.keys()], earliest)) {
      // the latest change on or before the payment — the nearest, so if it is outside the window every earlier one is too
      const changedOn = (changes.get(p.vendorId) ?? []).filter((d) => d <= p.paidAt).pop();
      if (changedOn == null || p.paidAt > businessDateShift(changedOn, windowDays)) continue;
      items.push({ ...p, amount: Number(p.amount), changedOn });
    }
    items.sort((a, b) => b.paidAt.localeCompare(a.paidAt) || a.kind.localeCompare(b.kind) || b.paymentId - a.paymentId);
    return { enabled: true, windowDays, items };
  },
};
