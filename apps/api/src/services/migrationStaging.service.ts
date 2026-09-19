/**
 * BATCH 1C — PHASE 2: the staged PARTIES, historical AR/AP OPEN ITEMS and
 * customer ADVANCES (decision pack §15.5 steps 3–5; accountant decision A1;
 * §15.2 C/D).
 *
 * What these rows ARE: the previous system's records, kept verbatim with their
 * source identity — the open documents at cut-off (original number, dates,
 * amounts, party), the advances held (with the old advance-invoice reference
 * and VAT position), and the parties they name.
 *
 * What they are NOT, by construction: tax invoices, bills, payments or VAT
 * events of Saudi Ledger. Nothing here posts; nothing here mints an ICV, a
 * hash, a QR or a ZATCA document; nothing here is read by any VAT return. The
 * commit (a later phase) turns them into `opening` items and deposits through
 * the one opening journal — and `invoices_opening_no_vat_chk` /
 * `bills_opening_no_vat_chk` refuse an opening row that carries any of those.
 *
 * Every semantic problem is computed ON READ from the staged content (a party
 * not staged, a date after the opening date, a number already taken…), so
 * the wizard, the opening position and the validator cannot disagree.
 */
import type { MigrationBatch, MigrationParty, MigrationOpenItem, MigrationAdvance, MigrationChartRow } from "@workspace/db";
import { round2 } from "../lib/money";
import { assertTaxCategoryCode } from "../lib/writeGuards";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../lib/errors";
import { migrationRepository } from "../repositories/migration.repository";
import { auditService } from "./audit.service";
import { migrationService } from "./migration.service";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{2}:\d{2}(:\d{2})?$/;
const num = (v: unknown) => Number(v ?? 0);
const fmt = (n: number) => n.toFixed(2);
const normName = (s: string) => s.trim().toLowerCase();
const isIsoDate = (v: unknown): v is string => typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v));

export type PartyInput = {
  partyType: "customer" | "vendor";
  sourceId: string;
  name: string;
  nameAr?: string | null;
  taxNumber?: string | null;
  crNumber?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
};

export type OpenItemInput = {
  itemType: "ar" | "ap";
  sourceId: string;
  partySourceId: string;
  documentNumber: string;
  issueDate: string;
  dueDate: string;
  originalAmount: number;
  outstandingAmount: number;
  compositionUnknown?: boolean;
  historicalVat?: { category?: string | null; rate?: number | null; taxableAmount?: number | null; amount?: number | null; reportedPeriod?: string | null } | null;
  description?: string | null;
};

export type AdvanceInput = {
  sourceId: string;
  partySourceId: string;
  bankSourceCode: string;
  amount: number;
  receivedAt: string;
  reference?: string | null;
  vatPosition: "invoiced" | "unknown";
  advanceInvoiceNumber?: string | null;
  advanceInvoiceDate?: string | null;
  advanceInvoiceTime?: string | null;
  vatCategory?: string | null;
  vatRate?: number | null;
  vatAmount?: number | null;
};

type Candidate = { id: number; name: string; taxNumber: string | null; reason: "source_id" | "tax_number" | "name" };

/** The whole staged content of a batch, read once — every problem below is a function of it. */
export type StagedContent = {
  batch: MigrationBatch;
  chart: MigrationChartRow[];
  parties: MigrationParty[];
  items: MigrationOpenItem[];
  advances: MigrationAdvance[];
  takenInvoiceNumbers: Set<string>;
  takenBillNumbers: Set<string>;
  existingCustomerIds: Set<number>;
  existingVendorIds: Set<number>;
};

export async function readStagedContent(batch: MigrationBatch): Promise<StagedContent> {
  const [chart, parties, items, advances] = await Promise.all([
    migrationRepository.chartRows(batch.id),
    migrationRepository.parties(batch.id),
    migrationRepository.openItems(batch.id),
    migrationRepository.advances(batch.id),
  ]);
  const [takenInvoiceNumbers, takenBillNumbers, customers, vendors] = await Promise.all([
    migrationRepository.takenInvoiceNumbers(items.filter((i) => i.itemType === "ar").map((i) => i.documentNumber)),
    migrationRepository.takenBillNumbers(items.filter((i) => i.itemType === "ap").map((i) => i.documentNumber)),
    migrationRepository.customersByIds(parties.filter((p) => p.partyType === "customer" && p.existingCustomerId != null).map((p) => p.existingCustomerId!)),
    migrationRepository.vendorsByIds(parties.filter((p) => p.partyType === "vendor" && p.existingVendorId != null).map((p) => p.existingVendorId!)),
  ]);
  return {
    batch, chart, parties, items, advances, takenInvoiceNumbers, takenBillNumbers,
    existingCustomerIds: new Set(customers.map((c) => c.id)),
    existingVendorIds: new Set(vendors.map((v) => v.id)),
  };
}

const partyKey = (type: string, sourceId: string) => `${type}:${sourceId}`;

function partyIndex(parties: MigrationParty[]) {
  return new Map(parties.map((p) => [partyKey(p.partyType, p.sourceId), p]));
}

// ── problems, computed on read ────────────────────────────────────────────────

export function partyProblems(p: MigrationParty, c: StagedContent, candidates: Candidate[]): string[] {
  const problems: string[] = [];
  if (p.decision == null) {
    problems.push(candidates.length > 0
      ? `likely duplicate of ${candidates.map((x) => `#${x.id} ${x.name} (${x.reason === "tax_number" ? "same VAT number" : x.reason === "source_id" ? "same source id" : "same name"})`).join(", ")} — decide create or use_existing`
      : "no decision");
  }
  if (p.decision === "create" && candidates.some((c) => c.reason === "source_id")) {
    const same = candidates.find((c) => c.reason === "source_id")!;
    problems.push(`${p.partyType} #${same.id} ${same.name} already carries source id ${p.sourceId} of ${p.sourceSystem} — it IS this party; use_existing`);
  }
  if (p.decision === "use_existing") {
    const id = p.partyType === "customer" ? p.existingCustomerId : p.existingVendorId;
    const exists = id != null && (p.partyType === "customer" ? c.existingCustomerIds.has(id) : c.existingVendorIds.has(id));
    if (!exists) problems.push(`the existing ${p.partyType} #${id ?? "?"} no longer exists — decide again`);
  }
  return problems;
}

export function openItemProblems(i: MigrationOpenItem, c: StagedContent): string[] {
  const problems: string[] = [];
  const idx = partyIndex(c.parties);
  const wantType = i.itemType === "ar" ? "customer" : "vendor";
  const party = idx.get(partyKey(wantType, i.partySourceId));
  if (!party) problems.push(`${wantType} ${i.partySourceId} is not staged in this batch's parties`);
  if (i.issueDate > c.batch.openingDate) problems.push(`issued ${i.issueDate}, after the opening date ${c.batch.openingDate} — not an item that was open at cut-off`);
  if (i.dueDate < i.issueDate) problems.push(`due ${i.dueDate} is before issue ${i.issueDate}`);
  const sameNumber = c.items.filter((o) => o.itemType === i.itemType && o.documentNumber === i.documentNumber);
  if (sameNumber.length > 1) problems.push(`document number ${i.documentNumber} appears ${sameNumber.length} times among the ${i.itemType.toUpperCase()} items — each opening item keeps its own number`);
  const taken = i.itemType === "ar" ? c.takenInvoiceNumbers : c.takenBillNumbers;
  if (taken.has(i.documentNumber)) problems.push(`document number ${i.documentNumber} already exists as a${i.itemType === "ar" ? "n invoice" : " bill"} of this company`);
  if (i.compositionUnknown) {
    const others = c.items.filter((o) => o.id !== i.id && o.itemType === i.itemType && o.partySourceId === i.partySourceId && o.compositionUnknown);
    if (others.length > 0) problems.push(`more than one composition-unknown item for ${wantType} ${i.partySourceId} — a party whose old system tracked only a balance gets ONE item`);
  }
  return problems;
}

export function advanceProblems(a: MigrationAdvance, c: StagedContent): string[] {
  const problems: string[] = [];
  const party = partyIndex(c.parties).get(partyKey("customer", a.partySourceId));
  if (!party) problems.push(`customer ${a.partySourceId} is not staged in this batch's parties`);
  const bankRow = c.chart.find((r) => r.sourceCode === a.bankSourceCode);
  if (!bankRow) problems.push(`bank account ${a.bankSourceCode} is not a row of the staged chart`);
  else if (bankRow.decision !== "map_to_bank") problems.push(`chart row ${a.bankSourceCode} is not mapped to a bank (${bankRow.decision ?? "undecided"}) — the advance's cash must be inside a bank's opening balance`);
  if (a.receivedAt > c.batch.openingDate) problems.push(`received ${a.receivedAt}, after the opening date ${c.batch.openingDate}`);
  if (a.advanceInvoiceDate && a.advanceInvoiceDate > c.batch.openingDate) problems.push(`advance invoice dated ${a.advanceInvoiceDate}, after the opening date`);
  return problems;
}

// ── output shapes ─────────────────────────────────────────────────────────────

function toPartyOut(p: MigrationParty, c: StagedContent, candidates: Candidate[]) {
  const items = c.items.filter((i) => i.partySourceId === p.sourceId && (p.partyType === "customer" ? i.itemType === "ar" : i.itemType === "ap"));
  const advances = p.partyType === "customer" ? c.advances.filter((a) => a.partySourceId === p.sourceId) : [];
  return {
    id: p.id,
    partyType: p.partyType as "customer" | "vendor",
    sourceId: p.sourceId,
    name: p.name,
    nameAr: p.nameAr ?? null,
    taxNumber: p.taxNumber ?? null,
    crNumber: p.crNumber ?? null,
    phone: p.phone ?? null,
    email: p.email ?? null,
    address: p.address ?? null,
    city: p.city ?? null,
    decision: (p.decision ?? null) as "create" | "use_existing" | null,
    existingId: (p.partyType === "customer" ? p.existingCustomerId : p.existingVendorId) ?? null,
    resolvedId: (p.partyType === "customer" ? p.resolvedCustomerId : p.resolvedVendorId) ?? null,
    candidates,
    openItems: items.length,
    openTotal: round2(items.reduce((s, i) => s + num(i.outstandingAmount), 0)),
    advances: advances.length,
    advanceTotal: round2(advances.reduce((s, a) => s + num(a.amount), 0)),
    problems: partyProblems(p, c, candidates),
  };
}

function toOpenItemOut(i: MigrationOpenItem, c: StagedContent) {
  const party = partyIndex(c.parties).get(partyKey(i.itemType === "ar" ? "customer" : "vendor", i.partySourceId));
  return {
    id: i.id,
    itemType: i.itemType as "ar" | "ap",
    sourceId: i.sourceId,
    partySourceId: i.partySourceId,
    partyName: party?.name ?? null,
    documentNumber: i.documentNumber,
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    originalAmount: num(i.originalAmount),
    outstandingAmount: num(i.outstandingAmount),
    compositionUnknown: i.compositionUnknown,
    historicalVat: (i.historicalVat ?? null) as OpenItemInput["historicalVat"],
    description: i.description ?? null,
    resolvedId: (i.itemType === "ar" ? i.resolvedInvoiceId : i.resolvedBillId) ?? null,
    problems: openItemProblems(i, c),
  };
}

function toAdvanceOut(a: MigrationAdvance, c: StagedContent) {
  const party = partyIndex(c.parties).get(partyKey("customer", a.partySourceId));
  return {
    id: a.id,
    sourceId: a.sourceId,
    partySourceId: a.partySourceId,
    partyName: party?.name ?? null,
    bankSourceCode: a.bankSourceCode,
    amount: num(a.amount),
    receivedAt: a.receivedAt,
    reference: a.reference ?? null,
    vatPosition: a.vatPosition as "invoiced" | "unknown",
    advanceInvoiceNumber: a.advanceInvoiceNumber ?? null,
    advanceInvoiceDate: a.advanceInvoiceDate ?? null,
    advanceInvoiceTime: a.advanceInvoiceTime ?? null,
    vatCategory: a.vatCategory ?? null,
    vatRate: a.vatRate == null ? null : num(a.vatRate),
    vatAmount: a.vatAmount == null ? null : num(a.vatAmount),
    resolvedPaymentId: a.resolvedPaymentId ?? null,
    problems: advanceProblems(a, c),
  };
}

function subledgerTotals(items: MigrationOpenItem[]) {
  return {
    items: items.length,
    parties: new Set(items.map((i) => i.partySourceId)).size,
    total: round2(items.reduce((s, i) => s + num(i.outstandingAmount), 0)),
    compositionUnknown: items.filter((i) => i.compositionUnknown).length,
  };
}

/**
 * The look-alikes among EXISTING records, per staged party.
 *
 * Two kinds, and they are not the same thing:
 *  - `source_id`: an existing record carries THIS party's (source_system,
 *    source_id) — written by an earlier commit of the same source. That IS the
 *    same party by construction (deterministic identity), so the import
 *    pre-decides `use_existing` on it — a re-run after a reversal resolves to
 *    the records it created the first time instead of duplicating them.
 *  - `tax_number` / `name`: a LIKELY duplicate. The decision is left empty; the
 *    operator says whether it is the same party. The platform never merges by
 *    a name or a number.
 */
export async function findCandidates(parties: MigrationParty[]): Promise<Map<number, Candidate[]>> {
  const out = new Map<number, Candidate[]>();
  for (const type of ["customer", "vendor"] as const) {
    const group = parties.filter((p) => p.partyType === type);
    if (group.length === 0) continue;
    const sourceSystem = group[0]!.sourceSystem;
    const taxNumbers = [...new Set(group.map((p) => p.taxNumber?.trim()).filter((t): t is string => !!t))];
    const names = [...new Set(group.map((p) => normName(p.name)))];
    const [byIdentity, found] = type === "customer"
      ? await Promise.all([migrationRepository.customersBySourceIdentity(sourceSystem, group.map((p) => p.sourceId)), migrationRepository.customerCandidates(taxNumbers, names)])
      : await Promise.all([migrationRepository.vendorsBySourceIdentity(sourceSystem, group.map((p) => p.sourceId)), migrationRepository.vendorCandidates(taxNumbers, names)]);
    for (const p of group) {
      const cands: Candidate[] = [];
      const same = byIdentity.find((f) => f.sourceId === p.sourceId);
      if (same) cands.push({ id: same.id, name: same.name, taxNumber: same.taxNumber ?? null, reason: "source_id" });
      for (const f of found) {
        if (same && f.id === same.id) continue;
        const tax = p.taxNumber?.trim();
        if (tax && f.taxNumber && f.taxNumber.trim() === tax) cands.push({ id: f.id, name: f.name, taxNumber: f.taxNumber, reason: "tax_number" });
        else if (normName(f.name) === normName(p.name)) cands.push({ id: f.id, name: f.name, taxNumber: f.taxNumber ?? null, reason: "name" });
      }
      out.set(p.id, cands);
    }
  }
  return out;
}

// ── the service ───────────────────────────────────────────────────────────────

export const migrationStagingService = {
  // ── parties ──
  async getParties(batchId: number) {
    const batch = await migrationService.requireBatch(batchId);
    const c = await readStagedContent(batch);
    const candidates = await findCandidates(c.parties);
    const rows = c.parties.map((p) => toPartyOut(p, c, candidates.get(p.id) ?? []));
    return {
      batchId,
      rows,
      summary: {
        rows: rows.length,
        customers: rows.filter((r) => r.partyType === "customer").length,
        vendors: rows.filter((r) => r.partyType === "vendor").length,
        undecided: rows.filter((r) => r.decision == null).length,
        useExisting: rows.filter((r) => r.decision === "use_existing").length,
        blocked: rows.filter((r) => r.problems.length > 0).length,
      },
    };
  },

  async importParties(batchId: number, body: { rows?: PartyInput[] | null }, userId: number | null) {
    const batch = await migrationService.requireBatch(batchId);
    migrationService.assertDraft(batch);
    const rows = body.rows ?? [];
    if (rows.length === 0) throw new BadRequestError("At least one party is required.");
    const seen = new Set<string>();
    const values = rows.map((r, i) => {
      if (r.partyType !== "customer" && r.partyType !== "vendor") throw new BadRequestError(`rows[${i}].partyType must be customer or vendor.`);
      const sourceId = String(r.sourceId ?? "").trim();
      const name = String(r.name ?? "").trim();
      if (!sourceId) throw new BadRequestError(`rows[${i}].sourceId is required — the old system's id is the identity every item refers to.`);
      if (!name) throw new BadRequestError(`rows[${i}].name is required.`);
      const key = partyKey(r.partyType, sourceId);
      if (seen.has(key)) throw new BadRequestError(`rows[${i}]: ${r.partyType} ${sourceId} appears twice in the file.`);
      seen.add(key);
      return {
        batchId,
        sourceSystem: batch.sourceSystem,
        partyType: r.partyType,
        sourceId,
        name,
        nameAr: r.nameAr?.trim() || null,
        taxNumber: r.taxNumber?.trim() || null,
        crNumber: r.crNumber?.trim() || null,
        phone: r.phone?.trim() || null,
        email: r.email?.trim() || null,
        address: r.address?.trim() || null,
        city: r.city?.trim() || null,
        decision: null as string | null,
      };
    });
    await migrationRepository.deleteParties(batchId);
    const inserted = await migrationRepository.insertParties(values);
    // A party with no look-alike among existing records is `create` — the only
    // outcome it admits. A look-alike leaves the decision EMPTY: the operator
    // says whether it is the same party; the platform never merges by itself.
    const candidates = await findCandidates(inserted);
    for (const p of inserted) {
      const cands = candidates.get(p.id) ?? [];
      const identity = cands.find((c) => c.reason === "source_id");
      if (identity) {
        await migrationRepository.updateParty(p.id, { decision: "use_existing", existingCustomerId: p.partyType === "customer" ? identity.id : null, existingVendorId: p.partyType === "vendor" ? identity.id : null });
      } else if (cands.length === 0) {
        await migrationRepository.updateParty(p.id, { decision: "create" });
      }
    }
    await migrationService.touch(batch);
    await auditService.record({ action: "migration_parties_import", entityType: "migration_batch", entityId: batchId, after: { rows: values.length, undecided: inserted.filter((p) => (candidates.get(p.id) ?? []).length > 0).length, by: userId } });
    return this.getParties(batchId);
  },

  async decideParty(batchId: number, rowId: number, body: { decision: "create" | "use_existing"; existingId?: number | null }, userId: number | null) {
    const batch = await migrationService.requireBatch(batchId);
    migrationService.assertDraft(batch);
    const [row] = await migrationRepository.findParty(batchId, rowId);
    if (!row) throw new NotFoundError("Party not found in this batch");
    const values: Partial<MigrationParty> = { decision: body.decision, existingCustomerId: null, existingVendorId: null, decidedBy: userId, decidedAt: new Date() };
    if (body.decision === "use_existing") {
      const id = Number(body.existingId);
      if (!Number.isInteger(id) || id <= 0) throw new BadRequestError("use_existing needs existingId.");
      const [existing] = row.partyType === "customer" ? await migrationRepository.customersByIds([id]) : await migrationRepository.vendorsByIds([id]);
      if (!existing) throw new BusinessRuleError(422, { error: `${row.partyType} ${id} does not exist for this organisation.`, code: "reference_not_found", field: "existingId" });
      const others = (await migrationRepository.parties(batchId)).filter((p) => p.id !== row.id && p.partyType === row.partyType && (row.partyType === "customer" ? p.existingCustomerId : p.existingVendorId) === id);
      if (others.length > 0) throw new BusinessRuleError(422, { error: `${row.partyType} ${id} (${existing.name}) is already used by staged party ${others[0].sourceId} — two old parties cannot become one record; merge them in the source file if they are one.`, code: "party_already_used", field: "existingId" });
      if (row.partyType === "customer") values.existingCustomerId = id; else values.existingVendorId = id;
    } else if (body.decision !== "create") {
      throw new BadRequestError("decision must be create or use_existing.");
    }
    const [updated] = await migrationRepository.updateParty(rowId, values);
    await migrationService.touch(batch);
    await auditService.record({
      action: "migration_party_decide", entityType: "migration_party", entityId: rowId,
      before: { decision: row.decision, existingCustomerId: row.existingCustomerId, existingVendorId: row.existingVendorId },
      after: { decision: updated.decision, existingCustomerId: updated.existingCustomerId, existingVendorId: updated.existingVendorId, by: userId },
    });
    const c = await readStagedContent(batch);
    const candidates = await findCandidates([updated]);
    return toPartyOut(updated, c, candidates.get(updated.id) ?? []);
  },

  // ── open items ──
  async getOpenItems(batchId: number) {
    const batch = await migrationService.requireBatch(batchId);
    const c = await readStagedContent(batch);
    const rows = c.items.map((i) => toOpenItemOut(i, c));
    return {
      batchId,
      rows,
      summary: {
        rows: rows.length,
        blocked: rows.filter((r) => r.problems.length > 0).length,
        ar: subledgerTotals(c.items.filter((i) => i.itemType === "ar")),
        ap: subledgerTotals(c.items.filter((i) => i.itemType === "ap")),
      },
    };
  },

  async importOpenItems(batchId: number, body: { rows?: OpenItemInput[] | null }, userId: number | null) {
    const batch = await migrationService.requireBatch(batchId);
    migrationService.assertDraft(batch);
    const rows = body.rows ?? [];
    if (rows.length === 0) throw new BadRequestError("At least one open item is required.");
    const seen = new Set<string>();
    const values = rows.map((r, i) => {
      const where = `rows[${i}]`;
      if (r.itemType !== "ar" && r.itemType !== "ap") throw new BadRequestError(`${where}.itemType must be ar or ap.`);
      const sourceId = String(r.sourceId ?? "").trim();
      const partySourceId = String(r.partySourceId ?? "").trim();
      const documentNumber = String(r.documentNumber ?? "").trim();
      if (!sourceId) throw new BadRequestError(`${where}.sourceId is required.`);
      if (seen.has(sourceId)) throw new BadRequestError(`${where}: source id ${sourceId} appears twice in the file — one row per old document.`);
      seen.add(sourceId);
      if (!partySourceId) throw new BadRequestError(`${where}.partySourceId is required.`);
      if (!documentNumber) throw new BadRequestError(`${where}.documentNumber is required — the original number is kept, never re-numbered.`);
      if (!isIsoDate(r.issueDate)) throw new BadRequestError(`${where}.issueDate must be YYYY-MM-DD.`);
      if (!isIsoDate(r.dueDate)) throw new BadRequestError(`${where}.dueDate must be YYYY-MM-DD.`);
      const original = round2(num(r.originalAmount)), outstanding = round2(num(r.outstandingAmount));
      if (!Number.isFinite(original) || original <= 0) throw new BadRequestError(`${where}.originalAmount must be a positive number.`);
      if (!Number.isFinite(outstanding) || outstanding <= 0) throw new BadRequestError(`${where}.outstandingAmount must be a positive number — a settled document is not an open item.`);
      if (outstanding > original + 0.005) throw new BadRequestError(`${where}: outstanding ${fmt(outstanding)} exceeds the original ${fmt(original)}.`);
      let historicalVat: OpenItemInput["historicalVat"] = null;
      if (r.historicalVat != null) {
        const v = r.historicalVat;
        assertTaxCategoryCode(v.category ?? null, `${where}.historicalVat.category`);
        for (const k of ["rate", "taxableAmount", "amount"] as const) {
          if (v[k] != null && (!Number.isFinite(num(v[k])) || num(v[k]) < 0)) throw new BadRequestError(`${where}.historicalVat.${k} must be a non-negative number.`);
        }
        if (v.rate != null && num(v.rate) > 100) throw new BadRequestError(`${where}.historicalVat.rate must be a percentage.`);
        historicalVat = {
          category: v.category ?? null,
          rate: v.rate == null ? null : round2(num(v.rate)),
          taxableAmount: v.taxableAmount == null ? null : round2(num(v.taxableAmount)),
          amount: v.amount == null ? null : round2(num(v.amount)),
          reportedPeriod: v.reportedPeriod?.trim() || null,
        };
      }
      return {
        batchId,
        sourceSystem: batch.sourceSystem,
        sourceId,
        itemType: r.itemType,
        partySourceId,
        documentNumber,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        originalAmount: fmt(original),
        outstandingAmount: fmt(outstanding),
        currency: "SAR",
        compositionUnknown: !!r.compositionUnknown,
        historicalVat,
        description: r.description?.trim() || null,
      };
    });
    await migrationRepository.deleteOpenItems(batchId);
    await migrationRepository.insertOpenItems(values);
    await migrationService.touch(batch);
    await auditService.record({ action: "migration_open_items_import", entityType: "migration_batch", entityId: batchId, after: { rows: values.length, ar: values.filter((v) => v.itemType === "ar").length, ap: values.filter((v) => v.itemType === "ap").length, by: userId } });
    return this.getOpenItems(batchId);
  },

  // ── advances ──
  async getAdvances(batchId: number) {
    const batch = await migrationService.requireBatch(batchId);
    const c = await readStagedContent(batch);
    const rows = c.advances.map((a) => toAdvanceOut(a, c));
    return {
      batchId,
      rows,
      summary: {
        rows: rows.length,
        blocked: rows.filter((r) => r.problems.length > 0).length,
        total: round2(rows.reduce((s, r) => s + r.amount, 0)),
        customers: new Set(rows.map((r) => r.partySourceId)).size,
        invoiced: rows.filter((r) => r.vatPosition === "invoiced").length,
        unknown: rows.filter((r) => r.vatPosition === "unknown").length,
      },
    };
  },

  async importAdvances(batchId: number, body: { rows?: AdvanceInput[] | null }, userId: number | null) {
    const batch = await migrationService.requireBatch(batchId);
    migrationService.assertDraft(batch);
    const rows = body.rows ?? [];
    if (rows.length === 0) throw new BadRequestError("At least one advance is required.");
    const seen = new Set<string>();
    const values = rows.map((r, i) => {
      const where = `rows[${i}]`;
      const sourceId = String(r.sourceId ?? "").trim();
      const partySourceId = String(r.partySourceId ?? "").trim();
      const bankSourceCode = String(r.bankSourceCode ?? "").trim();
      if (!sourceId) throw new BadRequestError(`${where}.sourceId is required.`);
      if (seen.has(sourceId)) throw new BadRequestError(`${where}: source id ${sourceId} appears twice in the file.`);
      seen.add(sourceId);
      if (!partySourceId) throw new BadRequestError(`${where}.partySourceId is required.`);
      if (!bankSourceCode) throw new BadRequestError(`${where}.bankSourceCode is required — the advance's cash sits inside that bank's opening balance.`);
      const amount = round2(num(r.amount));
      if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestError(`${where}.amount must be a positive number.`);
      if (!isIsoDate(r.receivedAt)) throw new BadRequestError(`${where}.receivedAt must be YYYY-MM-DD.`);
      if (r.vatPosition !== "invoiced" && r.vatPosition !== "unknown") throw new BadRequestError(`${where}.vatPosition must be invoiced or unknown.`);
      const invNo = r.advanceInvoiceNumber?.trim() || null;
      const invDate = r.advanceInvoiceDate?.trim() || null;
      const invTime = r.advanceInvoiceTime?.trim() || null;
      const vatCategory = r.vatCategory?.trim() || null;
      const vatRate = r.vatRate == null ? null : round2(num(r.vatRate));
      const vatAmount = r.vatAmount == null ? null : round2(num(r.vatAmount));
      if (r.vatPosition === "invoiced") {
        // Guideline v2 §8: the later invoice adjusts through PrepaidAmount by
        // reference to the advance invoice's number, date (and time), and the
        // VAT category/rate it was taxed at — all four are the reference.
        if (!invNo) throw new BadRequestError(`${where}: invoiced needs advanceInvoiceNumber — the old advance tax invoice's number.`);
        if (!invDate || !isIsoDate(invDate)) throw new BadRequestError(`${where}: invoiced needs advanceInvoiceDate (YYYY-MM-DD).`);
        if (invTime && !ISO_TIME.test(invTime)) throw new BadRequestError(`${where}.advanceInvoiceTime must be HH:MM or HH:MM:SS.`);
        if (!vatCategory) throw new BadRequestError(`${where}: invoiced needs vatCategory — the category the advance was taxed at.`);
        assertTaxCategoryCode(vatCategory, `${where}.vatCategory`);
        if (vatRate == null || !Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100) throw new BadRequestError(`${where}: invoiced needs vatRate (a percentage).`);
      } else if (invNo || invDate || invTime || vatCategory || vatRate != null || vatAmount != null) {
        throw new BadRequestError(`${where}: vatPosition unknown means the old advance invoice is not known — give its reference and mark invoiced, or omit the reference.`);
      }
      if (vatAmount != null && (!Number.isFinite(vatAmount) || vatAmount < 0 || vatAmount > amount)) throw new BadRequestError(`${where}.vatAmount must be between 0 and the advance amount.`);
      return {
        batchId,
        sourceSystem: batch.sourceSystem,
        sourceId,
        partySourceId,
        bankSourceCode,
        amount: fmt(amount),
        receivedAt: r.receivedAt,
        reference: r.reference?.trim() || null,
        vatPosition: r.vatPosition,
        advanceInvoiceNumber: invNo,
        advanceInvoiceDate: invDate,
        advanceInvoiceTime: invTime,
        vatCategory,
        vatRate: vatRate == null ? null : fmt(vatRate),
        vatAmount: vatAmount == null ? null : fmt(vatAmount),
      };
    });
    await migrationRepository.deleteAdvances(batchId);
    await migrationRepository.insertAdvances(values);
    await migrationService.touch(batch);
    await auditService.record({ action: "migration_advances_import", entityType: "migration_batch", entityId: batchId, after: { rows: values.length, unknownVatPosition: values.filter((v) => v.vatPosition === "unknown").length, by: userId } });
    return this.getAdvances(batchId);
  },
};
