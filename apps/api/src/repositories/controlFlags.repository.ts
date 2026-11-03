/**
 * 🔴 Phase 18 R-11a — DR-14's control flags (register §11.111). Tenant-scoped (RLS) and company-scoped
 * ({@link companyScoped}). The database fills in the organisation, the company and the declared actor (T1b) and
 * refuses any other actor, and the store is append-only for every role — this layer only adds and reads.
 */
import { db, controlFlagsTable as t, type ControlFlagKind } from "@workspace/db";
import { desc, sql } from "drizzle-orm";
import { companyScoped } from "./companyScope";

export type ControlFlagInput = {
  kind: ControlFlagKind;
  entityType: string;
  entityId: string | number;
  reference: string | null;
  firstAct: string;
  secondAct: string;
};

export type ControlFlagRow = typeof t.$inferSelect;

export const controlFlagsRepository = {
  /** One flag, written by the act it describes, in that act's transaction. */
  async record(f: ControlFlagInput): Promise<void> {
    await db.insert(t).values({
      kind: f.kind,
      entityType: f.entityType,
      entityId: String(f.entityId),
      reference: f.reference,
      firstAct: f.firstAct,
      secondAct: f.secondAct,
    });
  },

  /** A page of the active company's flags, newest first. */
  list(limit: number, offset: number): Promise<ControlFlagRow[]> {
    return db.select().from(t).where(companyScoped(t.companyId)).orderBy(desc(t.createdAt), desc(t.id)).limit(limit).offset(offset);
  },

  /** How many the active company has — the whole set the page belongs to. */
  async count(): Promise<number> {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(t).where(companyScoped(t.companyId));
    return Number(row?.n ?? 0);
  },
};
