/**
 * 🔴 19B S6 (v4 §4, §6.2; scope 19.9–19.13) — SAVED REPORTS: the builder's definitions.
 *
 * A definition names a dataset, its columns in order, a period, the dataset's declared filters and a sort — and nothing
 * else. Every save and every change is checked the way a run is: the request it would make is parsed by the dataset's
 * own parser (`parseRequest`) and asked of `decide()` with the `save` act, so a definition cannot name a column, a
 * filter or a sort its dataset does not offer, nor filter or sort by a column its author may not read.
 *
 *  - SHARING shows a definition to roles of the same organization; it grants nothing. A definition is listed only to a
 *    reader whose role may run its dataset, and every run asks `decide()` again for the runner's own role.
 *  - ONLY THE OWNER changes, shares or archives. A member who can see it is told so (403
 *    `report_definition_not_owner`); one who cannot gets 404 — the same answer as a missing one.
 *  - The organization and the company are the request's; a definition cannot name either.
 *  - A refused save or share is answered, not recorded (D6 records exports, schedules, deliveries and field writes).
 */
import { MEMBERSHIP_ROLES, type ReportAct, type ReportDefinitionRow } from "@workspace/db";
import { isReportPeriodKind, resolveReportPeriod, type ReportPeriod } from "@workspace/shared";
import { BusinessRuleError, NotFoundError } from "../../lib/errors";
import { DATASETS, type DatasetDef } from "../../lib/reports/datasets";
import { decide, NO_USE, type Has } from "../../lib/reports/decide";
import { membersRepository } from "../../repositories/members.repository";
import { reportDefinitionsRepository, type ReportDefinitionValues } from "../../repositories/reportDefinitions.repository";
import { parseRequest, refusalError } from "./reportDatasets.service";

export interface DefinitionActor { userId: number; organizationId: string; companyId: string | null; role: string }

const bad = (error: string, errorAr: string, code = "report_bad_filter") => new BusinessRuleError(400, { code, error, errorAr });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A definition as the query its dataset's own endpoint would be asked — the one parser, so the two cannot disagree. */
export function definitionQuery(d: Pick<ReportDefinitionValues, "columns" | "filters" | "sort">, window: { from: string; to: string } | null): Record<string, string> {
  const q: Record<string, string> = { ...d.filters };
  if (d.columns.length) q.columns = d.columns.join(",");
  if (d.sort) q.sort = d.sort;
  if (window) { q.date_from = window.from; q.date_to = window.to; }
  return q;
}

/** Reads a request body into a definition's values, refusing by name whatever the dataset does not offer. */
function parseBody(body: unknown): { ds: DatasetDef; values: ReportDefinitionValues } {
  if (!isRecord(body)) throw bad("A report definition is an object.", "تعريف التقرير يجب أن يكون كائناً.");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) throw bad("Give the report a name of up to 120 characters.", "أدخل اسماً للتقرير لا يتجاوز 120 حرفاً.");
  const ds = typeof body.dataset === "string" ? DATASETS[body.dataset] : undefined;
  if (!ds) throw bad("There is no such report data. Choose one from the list.", "لا توجد بيانات تقرير بهذا الاسم. اختر من القائمة.", "report_unknown_dataset");
  const columns = body.columns ?? [];
  if (!Array.isArray(columns) || columns.some((c) => typeof c !== "string" || !c) || new Set(columns).size !== columns.length) {
    throw bad("Columns are a list of column keys, each once.", "الأعمدة قائمة بمفاتيح الأعمدة، كل منها مرة واحدة.");
  }
  const p = body.period;
  if (!isRecord(p) || !isReportPeriodKind(p.kind)) throw bad("Choose the report's period.", "اختر فترة التقرير.");
  const period: ReportPeriod = { kind: p.kind, from: typeof p.from === "string" ? p.from : null, to: typeof p.to === "string" ? p.to : null };
  if (period.kind === "fixed") {
    if (!resolveReportPeriod(period, "2000-01-01")) throw bad("Fixed dates need a real start and end date, the start on or before the end.", "التواريخ المحددة تحتاج تاريخ بداية ونهاية صحيحين، والبداية لا تتجاوز النهاية.");
  } else if (p.from != null || p.to != null) {
    throw bad("A named period takes no dates: it is worked out each time the report runs.", "الفترة المسمّاة لا تأخذ تواريخ: تُحسب في كل مرة يُشغَّل فيها التقرير.");
  }
  const rawFilters = body.filters ?? {};
  if (!isRecord(rawFilters)) throw bad("Filters are an object.", "عوامل التصفية يجب أن تكون كائناً.");
  const filters: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawFilters)) {
    if (v == null || v === "") continue;
    // the period owns the dates; every other filter must be one the dataset declares
    if (k === "date_from" || k === "date_to" || !(k in ds.filters)) {
      throw bad(`The ${ds.title} report has no filter ${k}.`, `لا يحتوي تقرير «${ds.titleAr}» على عامل التصفية: ${k}.`);
    }
    if (typeof v !== "string" && typeof v !== "number") throw bad(`The filter ${k} takes one value.`, `عامل التصفية ${k} يأخذ قيمة واحدة.`);
    filters[k] = String(v);
  }
  const sort = body.sort == null || body.sort === "" ? null : body.sort;
  if (sort !== null && (typeof sort !== "string" || sort.length > 64)) throw bad("Sort is a column key.", "الترتيب يكون بمفتاح عمود.");
  return {
    ds,
    values: { name, dataset: ds.name, columns: columns as string[], periodKind: period.kind, dateFrom: period.kind === "fixed" ? period.from : null, dateTo: period.kind === "fixed" ? period.to : null, filters, sort },
  };
}

/** `decide()` for an act on a definition: the dataset's own parser on the query the definition makes, then the decision. */
export function decideDefinition(has: Has, ds: DatasetDef, act: ReportAct, values: Pick<ReportDefinitionValues, "columns" | "filters" | "sort">) {
  const { use } = parseRequest(ds, definitionQuery(values, { from: "2000-01-01", to: "2000-01-31" }), false);
  return decide(has, ds, act, use);
}

/** The same, refused by name. */
function check(has: Has, ds: DatasetDef, act: ReportAct, values: Pick<ReportDefinitionValues, "columns" | "filters" | "sort">) {
  const d = decideDefinition(has, ds, act, values);
  if (!d.allowed) throw refusalError(d);
}

const runnable = (has: Has, dataset: string) => { const ds = DATASETS[dataset]; return !!ds && decide(has, ds, "run", NO_USE).allowed; };

function out(row: ReportDefinitionRow, actor: DefinitionActor, names: Map<number, { name: string }>) {
  return {
    id: row.id,
    name: row.name,
    dataset: row.dataset,
    columns: row.columns,
    period: { kind: row.periodKind, from: row.dateFrom, to: row.dateTo },
    filters: row.filters,
    sort: row.sort,
    sharedRoles: [...row.sharedRoles].sort(),
    ownerUserId: row.ownerUserId,
    ownerName: names.get(row.ownerUserId)?.name ?? `#${row.ownerUserId}`,
    mine: row.ownerUserId === actor.userId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function one(row: ReportDefinitionRow, actor: DefinitionActor) {
  return out(row, actor, await membersRepository.namesAndRoles(actor.organizationId, [row.ownerUserId]));
}

/** A definition this member may see: theirs, or shared with their role AND on a dataset their role may run. */
async function visible(id: number, actor: DefinitionActor, has: Has): Promise<ReportDefinitionRow> {
  const row = Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647 ? await reportDefinitionsRepository.findVisible(id, actor.userId, actor.role) : null;
  if (!row || (row.ownerUserId !== actor.userId && !runnable(has, row.dataset))) throw new NotFoundError("Report not found");
  return row;
}

async function owned(id: number, actor: DefinitionActor, has: Has): Promise<ReportDefinitionRow> {
  const row = await visible(id, actor, has);
  if (row.ownerUserId !== actor.userId) {
    throw new BusinessRuleError(403, {
      code: "report_definition_not_owner",
      error: "Only the person who saved this report can change, share or remove it. Save your own copy to change it.",
      errorAr: "لا يمكن تغيير هذا التقرير أو مشاركته أو إزالته إلا لمن حفظه. احفظ نسختك الخاصة لتغييرها.",
    });
  }
  return row;
}

export const reportDefinitionsService = {
  async list(actor: DefinitionActor, has: Has) {
    const rows = (await reportDefinitionsRepository.listVisible(actor.userId, actor.role)).filter((r) => r.ownerUserId === actor.userId || runnable(has, r.dataset));
    const names = await membersRepository.namesAndRoles(actor.organizationId, [...new Set(rows.map((r) => r.ownerUserId))]);
    return { items: rows.map((r) => out(r, actor, names)) };
  },

  async get(id: number, actor: DefinitionActor, has: Has) {
    return one(await visible(id, actor, has), actor);
  },

  /** The definition's own row, for a member who may see it (a schedule is made on one) — else not found. */
  visibleRow(id: number, actor: DefinitionActor, has: Has): Promise<ReportDefinitionRow> {
    return visible(id, actor, has);
  },

  async create(body: unknown, actor: DefinitionActor, has: Has) {
    const { ds, values } = parseBody(body);
    check(has, ds, "save", values);
    if (!actor.companyId) throw new BusinessRuleError(422, { code: "company_required", error: "Create a company before saving a report.", errorAr: "أنشئ منشأة قبل حفظ تقرير." });
    return one(await reportDefinitionsRepository.insert({ organizationId: actor.organizationId, companyId: actor.companyId, ownerUserId: actor.userId }, values), actor);
  },

  async update(id: number, body: unknown, actor: DefinitionActor, has: Has) {
    await owned(id, actor, has);
    const { ds, values } = parseBody(body);
    check(has, ds, "save", values);
    return one(await reportDefinitionsRepository.update(id, values), actor);
  },

  async share(id: number, body: unknown, actor: DefinitionActor, has: Has) {
    const row = await owned(id, actor, has);
    const roles = isRecord(body) ? body.roles : undefined;
    if (!Array.isArray(roles) || roles.some((r) => typeof r !== "string" || !(MEMBERSHIP_ROLES as readonly string[]).includes(r))) {
      throw bad(`Share with roles from: ${MEMBERSHIP_ROLES.join(", ")}.`, `شارك مع أدوار من: ${MEMBERSHIP_ROLES.join("، ")}.`);
    }
    check(has, DATASETS[row.dataset]!, "share", row);
    return one(await reportDefinitionsRepository.update(id, { sharedRoles: [...new Set(roles as string[])].sort() }), actor);
  },

  /** Archived, never deleted: a schedule or a stored delivery that names it keeps its row. */
  async archive(id: number, actor: DefinitionActor, has: Has): Promise<void> {
    await owned(id, actor, has);
    await reportDefinitionsRepository.update(id, { archivedAt: new Date() });
  },
};
