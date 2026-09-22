/**
 * Companies service (M11.6) — read/update the active company's legal identity.
 *
 * WHY THIS MATTERS: `vatNumber` and `name` are not cosmetic settings. They are
 * the SELLER identity stamped into every issued e-invoice — ZATCA QR tags 1-2 and
 * the invoice hash chain (see `sellerIdentity.ts`). Before M11.6 they were
 * hardcoded to a sandbox placeholder, so every invoice carried a fake VAT number.
 * Validation here is therefore statutory, not cosmetic.
 */
import {
  GetCurrentCompanyResponse,
  ListFiscalYearsResponse,
  UpdateCurrentCompanyBody,
  UpdateCurrentCompanyResponse,
} from "@workspace/api-zod";
import { randomUUID } from "node:crypto";
import { BadRequestError, NotFoundError } from "../lib/errors";
import { storage } from "../lib/storage";
import { validateLogoBytes, LOGO_ALLOWED_MIME } from "../lib/fileValidation";
import { assertFileIsClean } from "../lib/malwareScanner";
import {
  BUILDING_NUMBER_RE, CR_NUMBER_HELP, CR_NUMBER_RE,
  POSTAL_CODE_RE, VAT_NUMBER_HELP, VAT_NUMBER_RE,
} from "../lib/saudiIdentifiers";
import { companiesRepository } from "../repositories/companies.repository";
import { auditService } from "./audit.service";
import {
  isFiscalCalendar,
  recentFiscalYears,
  fiscalYearContaining,
  type FiscalCalendar,
} from "../lib/fiscalYear";
import { isOwnershipType } from "../lib/zakatScope";
import type { companiesTable } from "@workspace/db";

type Company = typeof companiesTable.$inferSelect;
export type UpdateCompanyInput = ReturnType<(typeof UpdateCurrentCompanyBody)["parse"]>;

function buildCompanyOut(c: Company) {
  return {
    id: c.id,
    name: c.name,
    nameAr: c.nameAr ?? null,
    crNumber: c.crNumber ?? null,
    vatNumber: c.vatNumber ?? null,
    fiscalYearStart: c.fiscalYearStart,
    fiscalCalendar: c.fiscalCalendar,
    ownershipType: c.ownershipType ?? null,
    foreignOwnershipPct: c.foreignOwnershipPct == null ? null : Number(c.foreignOwnershipPct),
    vatTaxPeriod: c.vatTaxPeriod ?? null,
    hasLogo: !!c.logoPath,
    buildingNumber: c.buildingNumber ?? null,
    street: c.street ?? null,
    district: c.district ?? null,
    city: c.city ?? null,
    postalCode: c.postalCode ?? null,
  };
}

/**
 * Normalize an optional text field: `undefined` → leave unchanged, empty string
 * → clear (null), otherwise the trimmed value.
 */
function optionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

/** Validate a cleared-or-formatted identifier. */
function validateFormat(value: string | null | undefined, re: RegExp, help: string): void {
  if (value === undefined || value === null) return; // untouched or explicitly cleared
  if (!re.test(value)) throw new BadRequestError(help);
}

export const companiesService = {
  async getCurrent() {
    const company = await companiesRepository.findActive();
    if (!company) throw new NotFoundError("No company is configured for this organization.");
    return GetCurrentCompanyResponse.parse(buildCompanyOut(company));
  },

  /**
   * The active company's fiscal years, resolved to real date ranges (M17.2).
   *
   * This is the production consumer that `fiscal_year_start` never had. It
   * returns the CURRENT period plus a window either side, each with concrete
   * `startDate`/`endDate`/`days` — so a caller never re-derives boundaries, and
   * the settings page can show the user what their configuration actually
   * means instead of promising it is "stored for future use".
   */
  async fiscalYears() {
    const company = await companiesRepository.findActive();
    if (!company) throw new NotFoundError("No company is configured for this organization.");

    const calendar = (isFiscalCalendar(company.fiscalCalendar)
      ? company.fiscalCalendar
      : "gregorian") as FiscalCalendar;

    // M20.0 — NULL means NOT DECLARED (F8). The endpoint says so instead of
    // resolving a year nobody chose: `declared: false` with no periods, so
    // every consumer must handle the state explicitly rather than receiving a
    // January year that looks like an answer.
    if (company.fiscalYearStart == null) {
      return ListFiscalYearsResponse.parse({
        declared: false,
        calendar,
        fiscalYearStart: null,
        current: null,
        periods: [],
      });
    }

    const settings = { fiscalYearStart: company.fiscalYearStart, calendar };

    return ListFiscalYearsResponse.parse({
      declared: true,
      calendar,
      fiscalYearStart: settings.fiscalYearStart,
      current: fiscalYearContaining(settings),
      periods: recentFiscalYears(settings),
    });
  },

  async updateCurrent(input: UpdateCompanyInput) {
    const company = await companiesRepository.findActive();
    if (!company) throw new NotFoundError("No company is configured for this organization.");

    const updates: Partial<typeof companiesTable.$inferInsert> = {};

    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) throw new BadRequestError("Company name cannot be empty.");
      updates.name = name;
    }

    const nameAr = optionalText(input.nameAr);
    if (nameAr !== undefined) updates.nameAr = nameAr;

    // Statutory identifiers — format-checked (see lib/saudiIdentifiers).
    const crNumber = optionalText(input.crNumber);
    validateFormat(crNumber, CR_NUMBER_RE, CR_NUMBER_HELP);
    if (crNumber !== undefined) updates.crNumber = crNumber;

    const vatNumber = optionalText(input.vatNumber);
    validateFormat(vatNumber, VAT_NUMBER_RE, VAT_NUMBER_HELP);
    if (vatNumber !== undefined) updates.vatNumber = vatNumber;

    if (input.fiscalYearStart !== undefined) {
      // M20.0 — null WITHDRAWS the declaration (the M17.1 ownership pattern:
      // a tenant who no longer knows may say so, and a withdrawn declaration
      // returns reports to the rolling-window fallback rather than leaving a
      // stale claim steering them).
      if (input.fiscalYearStart === null) {
        updates.fiscalYearStart = null;
      } else {
        const m = Number(input.fiscalYearStart);
        if (!Number.isInteger(m) || m < 1 || m > 12) {
          throw new BadRequestError("fiscalYearStart must be a month number between 1 and 12.");
        }
        updates.fiscalYearStart = m;
      }
    }

    // M17.2 — changing this REINTERPRETS `fiscalYearStart` (1 = January under
    // gregorian, 1 = Muharram under hijri), so it is validated here for a
    // readable 400 and by a DB CHECK for every other writer.
    if (input.fiscalCalendar !== undefined) {
      if (!isFiscalCalendar(input.fiscalCalendar)) {
        throw new BadRequestError("fiscalCalendar must be 'gregorian' or 'hijri'.");
      }
      updates.fiscalCalendar = input.fiscalCalendar;
    }

    // M17.1 — ownership structure (Q2). An empty string clears it back to NOT
    // DECLARED, which is a legitimate state a tenant may return to: it is
    // better for a company that no longer knows to say so than to leave a
    // stale claim standing, because that claim gates the Zakat surface.
    if (input.ownershipType !== undefined) {
      const raw = input.ownershipType === null ? null : String(input.ownershipType).trim();
      const value = raw === "" ? null : raw;
      if (value !== null && !isOwnershipType(value)) {
        throw new BadRequestError("ownershipType must be 'SAUDI_GCC', 'FOREIGN' or 'MIXED'.");
      }
      updates.ownershipType = value;
    }

    /**
     * FA-E (2026-09-22) — the share subject to INCOME TAX. The column has
     * existed since FA-A and until now had NO WRITER: the Art. 17 pool reads
     * it, so a report that refuses because the share is undeclared would have
     * been naming a control that did not exist (a refusal that hides the
     * control). This is that control.
     *
     * 🔴 It is checked AGAINST `ownershipType`, and the two are read together
     * because the Law reads them together: Income Tax Law Art. 2 taxes the
     * non-Saudi/non-GCC share, and Zakat Regulations Art. 6(1) takes the rest.
     * A company that calls itself SAUDI_GCC and declares 40 % foreign is
     * stating two different facts about itself, and the platform refuses the
     * pair rather than silently preferring one of them — the DB CHECK pins the
     * same rule, and this is the message that explains it.
     */
    if (input.foreignOwnershipPct !== undefined) {
      const raw = input.foreignOwnershipPct;
      const value = raw === null || String(raw).trim() === "" ? null : Number(raw);
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) {
        throw new BadRequestError("foreignOwnershipPct must be a percentage between 0 and 100.");
      }
      const declaredType = updates.ownershipType !== undefined ? updates.ownershipType : company.ownershipType;
      if (value !== null) {
        // 🔴 The DB CHECK (companies_foreign_ownership_pct_chk, migration 0088)
        // refuses a share with NO ownership type at all, so the service refuses
        // it first with a sentence — otherwise the tenant gets a raw 23514.
        if (declaredType == null) {
          throw new BadRequestError("Declare the ownership structure before the share: the two are one statement, and a percentage on its own says nothing about which regime applies.");
        }
        const expected: Record<string, (v: number) => boolean> = {
          SAUDI_GCC: (v) => v === 0,
          FOREIGN: (v) => v === 100,
          MIXED: (v) => v > 0 && v < 100,
        };
        if (expected[declaredType] && !expected[declaredType]!(value)) {
          throw new BadRequestError(
            `An ownership structure of ${declaredType} and a non-Saudi/non-GCC share of ${value}% state different facts: SAUDI_GCC means 0%, FOREIGN means 100%, and MIXED means strictly between. Correct one of them.`,
          );
        }
      }
      updates.foreignOwnershipPct = value === null ? null : String(value);
    }

    /**
     * FA-F (2026-09-22) — the VAT TAX PERIOD. Art. 52(5) opens a capital
     * asset's first twelve-month adjustment window at the start of the tax
     * period of acquisition and files the adjustment in the return for the last
     * tax period inside it, so monthly and quarterly give different windows and
     * different returns for the same purchase.
     *
     * 🔴 It is asked, not inferred. Art. 58's SAR 40,000,000 threshold is not
     * the only way a period is assigned — a smaller taxpayer may be assigned or
     * may elect monthly — so deriving it from the tenant's own turnover would
     * have the platform assert a legal fact about them from their books.
     * Clearing it back to NOT DECLARED is legitimate, as for every other
     * declaration on this record.
     */
    if (input.vatTaxPeriod !== undefined) {
      const raw = input.vatTaxPeriod === null ? null : String(input.vatTaxPeriod).trim();
      const value = raw === "" ? null : raw;
      if (value !== null && value !== "monthly" && value !== "quarterly") {
        throw new BadRequestError("vatTaxPeriod must be 'monthly' or 'quarterly' (VAT IR Art. 58).");
      }
      updates.vatTaxPeriod = value;
    }

    // Address block (ZATCA Phase 2 / printed invoices) — free text except the
    // two numeric national-address fields.
    const buildingNumber = optionalText(input.buildingNumber);
    validateFormat(buildingNumber, BUILDING_NUMBER_RE, "Building number must be 4 digits.");
    if (buildingNumber !== undefined) updates.buildingNumber = buildingNumber;

    const postalCode = optionalText(input.postalCode);
    validateFormat(postalCode, POSTAL_CODE_RE, "Postal code must be 5 digits.");
    if (postalCode !== undefined) updates.postalCode = postalCode;

    for (const key of ["street", "district", "city"] as const) {
      const v = optionalText(input[key]);
      if (v !== undefined) updates[key] = v;
    }

    if (Object.keys(updates).length === 0) throw new BadRequestError("No changes supplied.");

    const [updated] = await companiesRepository.update(company.id, updates);
    await auditService.updated("company", company.id, buildCompanyOut(company), buildCompanyOut(updated));
    return UpdateCurrentCompanyResponse.parse(buildCompanyOut(updated));
  },

  // ── L1 level-1 branding: the logo (design-invoice-document.md §2) ─────────
  // One upload per company, brokered through the API into the private bucket
  // (the storage seam). Absent = the invoice header carries the registered
  // name alone — no fallback mark, by decision.

  /** Validate, scan, store, and record the company logo. Replaces any existing one. */
  async uploadLogo(organizationId: string, file: { buffer: Buffer } | undefined) {
    if (!file || !file.buffer) throw new BadRequestError("A file is required (field name: 'file').");
    const company = await companiesRepository.findActive();
    if (!company) throw new NotFoundError("No company is configured for this organization.");

    // Trust the bytes (M-5's rule applies to the logo too), then scan BEFORE
    // any bytes reach storage.
    const mimeType = validateLogoBytes(file.buffer);
    await assertFileIsClean(file.buffer, { kind: "company_logo" });

    const ext = LOGO_ALLOWED_MIME[mimeType];
    const objectPath = `${organizationId}/logo/${company.id}-${randomUUID()}.${ext}`;

    await storage.ensureBucket();
    await storage.putObject(objectPath, file.buffer, mimeType);

    const previous = company.logoPath;
    await companiesRepository.update(company.id, { logoPath: objectPath });
    await auditService.updated("company", company.id, { logoPath: previous }, { logoPath: objectPath });

    // The old object is unreferenced the moment the row points elsewhere;
    // removal is best-effort by the seam's own contract.
    if (previous) await storage.removeObject(previous);
    return { hasLogo: true as const };
  },

  /** The stored logo's bytes + content type. 404 when there is none. */
  async getLogo() {
    const company = await companiesRepository.findActive();
    if (!company?.logoPath) throw new NotFoundError("This company has no logo.");
    return storage.getObject(company.logoPath);
  },

  /** Remove the logo: the header returns to the registered name alone. */
  async removeLogo() {
    const company = await companiesRepository.findActive();
    if (!company) throw new NotFoundError("No company is configured for this organization.");
    if (!company.logoPath) return { hasLogo: false as const };
    await companiesRepository.update(company.id, { logoPath: null });
    await auditService.updated("company", company.id, { logoPath: company.logoPath }, { logoPath: null });
    await storage.removeObject(company.logoPath);
    return { hasLogo: false as const };
  },
};
