/**
 * THE ZAKAT CLASSIFICATION OF THE CHART (pack §3.3; owner Q6 — "classification
 * moves to the chart of accounts"; the M17.3 grain question answered leaf-only).
 *
 * Every asset and liability posting account carries ONE of eight classes, each
 * tied to its article of the 1445H Regulations. 🔴 Only a PERSON's
 * classification is stored: a suggestion is computed here from what the
 * account IS (its liquidity class, or its role as a fixed-asset cost or
 * accumulated-depreciation account — Art. 49's "net fixed assets") and is
 * pre-selected for confirmation, never applied by itself. Equity accounts are
 * equity by their own SOCPA type (Art. 9, 23(1)) and are never classified.
 */
import { ZAKAT_CLASSES, type ZakatClass } from "@workspace/db";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../../lib/errors";
import { taxRepository } from "../../repositories/tax.repository";
import { reportsRepository } from "../../repositories/reports.repository";
import { auditService } from "../audit.service";

/** The article each class stands on — shown beside it on every page. */
export const ZAKAT_CLASS_ARTICLE: Record<ZakatClass, string> = {
  equity: "23(1), 30, 36",
  provision_as_equity: "24",
  noncurrent_liability: "29(1)",
  current_liability: "29(2)",
  noncurrent_asset_deducted: "26, 43–51",
  noncurrent_asset_not_deducted: "42, 48",
  current_asset_deducted: "26(6), 32, 52",
  current_asset_not_deducted: "26, 52",
};

const ASSET_CLASSES: ZakatClass[] = ["noncurrent_asset_deducted", "noncurrent_asset_not_deducted", "current_asset_deducted", "current_asset_not_deducted"];
const LIABILITY_CLASSES: ZakatClass[] = ["equity", "provision_as_equity", "noncurrent_liability", "current_liability"];

type Cat = Awaited<ReturnType<typeof reportsRepository.allCategories>>[number];

/** The accounts this company's fixed-asset categories post to — Art. 49's net fixed assets, by construction of the register (the cash-flow's one reader). */
async function fixedAssetAccountIds(): Promise<Set<number>> {
  const rows = await reportsRepository.fixedAssetAccounts();
  return new Set(rows.flatMap((r) => [r.cost, r.accumulated]));
}

/** A suggestion from what the account IS — or null where nothing about it decides the class. */
export function suggestZakatClass(c: Pick<Cat, "type" | "liquidityClass" | "systemCode">, fixedAsset: boolean): ZakatClass | null {
  if (c.type === "asset") {
    if (fixedAsset || c.systemCode === "ACCUMULATED_DEPRECIATION") return "noncurrent_asset_deducted";
    if (c.liquidityClass === "non_current") return null; // could be an investment, held for trading, or for use — the person decides
    if (c.liquidityClass === "cash" || c.liquidityClass === "quick" || c.liquidityClass === "current") return "current_asset_not_deducted";
    return null;
  }
  if (c.type === "liability") {
    if (c.liquidityClass === "current") return "current_liability";
    if (c.liquidityClass === "non_current") return "noncurrent_liability";
    return null;
  }
  return null;
}

export const zakatClassificationService = {
  /** Every asset and liability posting leaf of the chart, with its class (if confirmed) and a suggestion. */
  async list() {
    const [cats, stored, fa] = await Promise.all([reportsRepository.allCategories(), taxRepository.classifications(), fixedAssetAccountIds()]);
    const byAccount = new Map(stored.map((s) => [s.accountId, s]));
    return cats
      .filter((c) => (c.type === "asset" || c.type === "liability") && c.isPosting !== false)
      .map((c) => {
        const s = byAccount.get(c.id);
        return {
          accountId: c.id, name: c.name, nameAr: c.nameAr ?? null, type: c.type as "asset" | "liability",
          liquidityClass: c.liquidityClass ?? null, systemCode: c.systemCode ?? null,
          classification: (s?.classification ?? null) as ZakatClass | null,
          article: s ? ZAKAT_CLASS_ARTICLE[s.classification as ZakatClass] : null,
          basisNote: s?.basisNote ?? null,
          confirmedBy: s?.confirmedBy ?? null,
          confirmedAt: s?.confirmedAt ? s.confirmedAt.toISOString() : null,
          suggestion: s ? null : suggestZakatClass(c, fa.has(c.id)),
          allowed: c.type === "asset" ? ASSET_CLASSES : LIABILITY_CLASSES,
        };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "asset" ? -1 : 1));
  },

  /** Confirm (or change) one account's class. Audited, before → after. */
  async set(accountId: number, body: { classification?: unknown; basisNote?: unknown }, userId: number | null) {
    const cls = String(body.classification ?? "");
    if (!(ZAKAT_CLASSES as readonly string[]).includes(cls)) throw new BadRequestError(`classification must be one of ${ZAKAT_CLASSES.join(", ")}.`);
    const cats = await reportsRepository.allCategories();
    const cat = cats.find((c) => c.id === accountId);
    if (!cat) throw new NotFoundError("Account not found.");
    if (cat.type !== "asset" && cat.type !== "liability") {
      throw new BusinessRuleError(422, { code: "zakat_class_type", error: "Only asset and liability accounts are classified: an equity account is equity (Art. 23(1)), and income and expense enter the base through net profit." });
    }
    const allowed = cat.type === "asset" ? ASSET_CLASSES : LIABILITY_CLASSES;
    if (!allowed.includes(cls as ZakatClass)) {
      throw new BusinessRuleError(422, { code: "zakat_class_type", error: `A${cat.type === "asset" ? "n asset" : " liability"} takes one of: ${allowed.join(", ")}.` });
    }
    const basisNote = typeof body.basisNote === "string" && body.basisNote.trim() ? body.basisNote.trim() : null;
    const { before, after } = await taxRepository.upsertClassification(accountId, cls, basisNote, userId);
    await auditService.record({ action: before ? "update" : "create", entityType: "zakat_account_classification", entityId: accountId, before, after });
    return (await this.list()).find((a) => a.accountId === accountId)!;
  },

  /** Withdraw a classification — the account reads unclassified again (and blocks a computation while it carries a balance). */
  async clear(accountId: number) {
    const removed = await taxRepository.deleteClassification(accountId);
    if (!removed) throw new NotFoundError("This account has no Zakat classification.");
    await auditService.deleted("zakat_account_classification", accountId, removed);
  },
};
