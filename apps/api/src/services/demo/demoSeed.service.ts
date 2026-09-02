/**
 * The demo tenant (docs/product/demo-deployment-decisions.md D2, D8).
 *
 * 🔴 EVERY LEDGER EFFECT HERE GOES THROUGH THE PRODUCT'S OWN WRITE PATHS.
 * Invoices and bills are created and approved through `invoicesService` /
 * `billsService`, so the GL entries, hash chain, VAT lines and audit rows are
 * the ones a real user's clicks would produce. A seed that INSERTed journal
 * lines directly would be a second posting path for an effect that already has
 * one (§4) — and worse for a demo, it would be showing figures the product
 * cannot actually produce.
 *
 * That also makes this seed an instance of standing rule 2: the demo is
 * validated from real ledger rows, because the rows come from the write path.
 *
 * DELIBERATELY MINIMAL (owner: "he needs to see the shape of what's built, not
 * six months of realistic history"). Enough months that the trend charts have
 * points and enough documents that the statements have lines — nothing more.
 *
 * 🔴 THE SEEDED STATE IS CLAIMABLE ON PURPOSE. No suspense balance and no
 * unclassified balance-sheet account, so the Finance Hub liquidity claim is
 * MADE. That is what makes uploading the sample bank statement a demonstration:
 * accepting an uncategorised row posts to SUSPENSE and the claim is withheld in
 * front of the viewer. Seeding it already-withheld would show the guard's
 * output without ever showing the guard work.
 */
import { and, eq, sql } from "drizzle-orm";
import { hashPassword } from "../../lib/password";
import {
  db,
  ownerDb,
  beginTenantConnection,
  organizationsTable,
  companiesTable,
  usersTable,
  organizationMembershipsTable,
  categoriesTable,
} from "@workspace/db";
import { auditContext } from "../../lib/auditContext";
import { customersService } from "../customers.service";
import { vendorsService } from "../vendors.service";
import { bankAccountsService } from "../bankAccounts.service";
import { invoicesService } from "../invoices.service";
import { billsService } from "../bills.service";
import { budgetsService } from "../budgets.service";

/** The demo tenant's stable natural key. The reset guard keys off this. */
export const DEMO_ORG_SLUG = "demo";
export const DEMO_ORG_NAME = "DEMO — Falcon Trading Est.";
export const DEMO_COMPANY_NAME = "Falcon Trading Est.";

/**
 * 🔴 An OBVIOUSLY invalid VAT registration number (owner's requirement).
 *
 * A real KSA VAT number is 15 digits beginning and ending with 3. This one has
 * the right shape — so the product's own validators exercise a realistic input
 * — and is unmistakably fictional to anyone who glances at it. It must never
 * resemble a number that could belong to a real taxpayer, because a demo
 * generates documents that carry it.
 *
 * ZATCA submission is refused outright in demo mode (`env.ts` superRefine), so
 * this number can never reach a government API. The invalid value is the second
 * line of defence, not the first.
 */
export const DEMO_VAT_NUMBER = "399999999999993";


export interface DemoSeedResult {
  organizationId: string;
  companyId: string;
  adminEmail: string;
  invoices: number;
  bills: number;
  months: number;
}

/** How many months of history the demo carries, inclusive of the current one. */
const MONTHS = 7;

/** Deterministic so a reset reproduces the same demo, not a different one. */
const SALES = [42_000, 38_500, 51_250, 47_800, 61_000, 44_300, 55_600];
const PURCHASES = [18_400, 21_050, 19_900, 26_700, 23_150, 20_800, 24_400];

function monthStart(now: Date, monthsAgo: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
}

/** `YYYY-MM-DD` for a day inside the given month (documents are dated mid-month). */
function dateIn(now: Date, monthsAgo: number, day: number): string {
  const d = monthStart(now, monthsAgo);
  d.setUTCDate(day);
  return d.toISOString().slice(0, 10);
}

/**
 * Create the demo tenant's identity rows.
 *
 * These touch `organizations` / `users` / `organization_memberships`, which are
 * OUTSIDE RLS and off-limits to the business layer (§4). That is correct here:
 * this is provisioning, the same layer the ordinary seed and the signup service
 * work at — not a business-layer read.
 */
async function ensureIdentity(
  adminEmail: string,
  adminPassword: string,
  adminName: string,
): Promise<{ organizationId: string; companyId: string; userId: number }> {
  // The organizations INSERT trigger seeds the chart of accounts AND the
  // default categories for the new org, so nothing here has to.
  /**
   * 🔴 Pre-tenant writes use the OWNER connection, NAMED.
   *
   * Creating the organization, its company, the admin user and the membership
   * all happen BEFORE a tenant scope can exist — they are what makes one
   * possible. Everything after `inTenant` below is tenant-scoped and keeps
   * using `db`, which now REFUSES to run outside a scope rather than falling
   * back here silently. This file needs both handles, and now says which is
   * which at each call.
   */
  let [org] = await ownerDb
    .select()
    .from(organizationsTable)
    .where(eq(organizationsTable.slug, DEMO_ORG_SLUG))
    .limit(1);

  if (!org) {
    [org] = await ownerDb
      .insert(organizationsTable)
      .values({ name: DEMO_ORG_NAME, slug: DEMO_ORG_SLUG, verificationStatus: "approved" })
      .returning();
  }

  let [company] = await ownerDb
    .select()
    .from(companiesTable)
    .where(
      and(eq(companiesTable.organizationId, org!.id), eq(companiesTable.name, DEMO_COMPANY_NAME)),
    )
    .limit(1);

  if (!company) {
    [company] = await ownerDb
      .insert(companiesTable)
      .values({
        organizationId: org!.id,
        name: DEMO_COMPANY_NAME,
        vatNumber: DEMO_VAT_NUMBER,
      })
      .returning();
  }

  let [user] = await ownerDb
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, adminEmail))
    .limit(1);

  if (!user) {
    const passwordHash = await hashPassword(adminPassword);
    [user] = await ownerDb
      .insert(usersTable)
      .values({ email: adminEmail, name: adminName, passwordHash, role: "admin", isActive: true })
      .returning({ id: usersTable.id });
  }

  // 🔴 ADMIN, not viewer (owner's decision): the reviewer is trusted, the
  // weekly reset makes any mess temporary, and a half-hidden product is a worse
  // review than a fully clickable one. The authority that matters is still
  // refused at the route — capture and signup are off for every role.
  await ownerDb
    .insert(organizationMembershipsTable)
    .values({
      userId: user!.id,
      organizationId: org!.id,
      role: "admin",
      status: "active",
    })
    .onConflictDoNothing({
      target: [organizationMembershipsTable.userId, organizationMembershipsTable.organizationId],
    });

  return { organizationId: org!.id, companyId: company!.id, userId: user!.id };
}

/**
 * Seed the demo tenant. Safe to call repeatedly: identity rows are looked up by
 * their natural keys, and business data is only written when the tenant has
 * none (so a re-run after a partial reset does not double the history).
 */
export async function seedDemoTenant(opts: {
  adminEmail: string;
  adminPassword: string;
  adminName?: string;
  now?: Date;
}): Promise<DemoSeedResult> {
  const now = opts.now ?? new Date();
  const { organizationId, companyId, userId } = await ensureIdentity(
    opts.adminEmail,
    opts.adminPassword,
    opts.adminName ?? "Demo Reviewer",
  );

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({
      organizationId,
      companyId,
      role: "authenticated",
    });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId, ipAddress: null }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  // Already populated? Leave it alone. The reset path empties the tenant first,
  // so this only short-circuits an accidental double-seed.
  const existing = await inTenant(async () => {
    const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM invoices`);
    return Number((rows as unknown as { rows: { n: number }[] }).rows?.[0]?.n ?? 0);
  });
  if (existing > 0) {
    return {
      organizationId,
      companyId,
      adminEmail: opts.adminEmail,
      invoices: existing,
      bills: 0,
      months: MONTHS,
    };
  }

  return inTenant(async () => {
    await bankAccountsService.create({
      name: "Main Operating Account",
      bankName: "Al Rajhi Bank",
      iban: "SA0380000000608010167519",
      currency: "SAR",
      openingBalance: 150_000,
      balance: 150_000,
      isDefault: true,
    });

    const customerA = await customersService.create({
      name: "Al-Nahda Contracting Co.",
      nameAr: "شركة النهضة للمقاولات",
      vatNumber: "310000000000003",
      email: "accounts@al-nahda.example",
    } as never);
    const customerB = await customersService.create({
      name: "Rawabi Logistics",
      nameAr: "روابي للخدمات اللوجستية",
      email: "finance@rawabi.example",
    } as never);

    const vendorA = await vendorsService.create({
      name: "Tamimi Office Supplies",
      nameAr: "التميمي للأدوات المكتبية",
      vatNumber: "311111111111113",
    } as never);
    const vendorB = await vendorsService.create({
      name: "Saudi Telecom Business",
      nameAr: "الاتصالات السعودية للأعمال",
      vatNumber: "312222222222223",
    } as never);

    let invoiceCount = 0;
    let billCount = 0;

    // Oldest month first, so invoice numbers and the ICV sequence run forward —
    // out-of-order approvals fork the ZATCA chain sequentially (§4), and a demo
    // should not model the one ordering the platform warns about.
    for (let i = MONTHS - 1; i >= 0; i--) {
      const idx = MONTHS - 1 - i;
      const seq = String(idx + 1).padStart(3, "0");
      const net = SALES[idx]!;
      const customerId = idx % 2 === 0 ? customerA.id : customerB.id;

      const invoice = await invoicesService.create(
        {
          invoiceNumber: `INV-${seq}`,
          date: dateIn(now, i, 8),
          dueDate: dateIn(now, i, 28),
          customerId,
          items: [
            {
              description: idx % 2 === 0 ? "Consulting services" : "Equipment supply",
              quantity: 1,
              unitPrice: net,
              vatRate: 15,
            },
          ],
        },
        userId,
      );
      // 🔴 Two acts: auto-approve was removed from the product (2026-08-28), so
      // the demo issues its invoices the way a tenant now must — create, then
      // approve the specific document.
      await invoicesService.approve((invoice as { id: number }).id, userId);
      invoiceCount++;

      // Older invoices are settled; the two most recent stay outstanding so AR
      // aging, the receivables surface and the cash-flow chart all have
      // something to say.
      if (i >= 2) {
        await invoicesService.pay(
          invoice.id,
          { amount: Number(invoice.total), paidAt: dateIn(now, i, 25) },
          userId,
        );
      }

      const spend = PURCHASES[idx]!;
      const bill = await billsService.create(
        {
          billNumber: `BILL-${seq}`,
          date: dateIn(now, i, 12),
          dueDate: dateIn(now, i, 30),
          vendorId: idx % 2 === 0 ? vendorA.id : vendorB.id,
          subtotal: spend.toFixed(2),
          vatAmount: (Math.round(spend * 15) / 100).toFixed(2),
          total: (spend + Math.round(spend * 15) / 100).toFixed(2),
          items: [],
        },
        userId,
      );
      await billsService.approve(bill.id, {}, userId);
      billCount++;

      if (i >= 1) {
        await billsService.pay(
          bill.id,
          { amount: spend + Math.round(spend * 15) / 100, paidAt: dateIn(now, i, 27) },
          userId,
        );
      }
    }

    // An annual budget so the Analytics budget table (M19.5) has rows rather
    // than an explanation of why it is empty.
    const [salesCategory] = await db
      .select({ id: categoriesTable.id })
      .from(categoriesTable)
      .where(eq(categoriesTable.systemCode, "SALES"))
      .limit(1);
    const [rentCategory] = await db
      .select({ id: categoriesTable.id })
      .from(categoriesTable)
      .where(eq(categoriesTable.systemCode, "RENT_UTILITIES"))
      .limit(1);

    const year = String(now.getUTCFullYear());
    if (salesCategory) {
      await budgetsService.create({
        name: "Sales target",
        nameAr: "هدف المبيعات",
        period: year,
        categoryId: salesCategory.id,
        budgetedAmount: 480_000,
      });
    }
    if (rentCategory) {
      await budgetsService.create({
        name: "Rent & utilities",
        nameAr: "الإيجار والمرافق",
        period: year,
        categoryId: rentCategory.id,
        budgetedAmount: 120_000,
      });
    }

    return {
      organizationId,
      companyId,
      adminEmail: opts.adminEmail,
      invoices: invoiceCount,
      bills: billCount,
      months: MONTHS,
    };
  });
}
