/**
 * Batch 1C — the migration workspace's shared pieces (2026-09-20).
 *
 * Everything here reads the server's own answer and renders it. No figure on
 * any migration screen is computed on the client: the opening position, the
 * balance difference, every control, R1–R10 and each row's `problems` come
 * from the API. The client only decides WHERE to show them and WHICH staging
 * record a failure points at.
 *
 * The workspace's state lives in the URL (`?section=…&focus=<rowId>`), so a
 * validation failure can hand the operator a link to the exact record, and a
 * copied address reproduces the screen.
 */
import { useCallback, useEffect, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, CircleSlash, Info } from "lucide-react";
import { SECTIONS, type WorkspaceSection, verdictOf, verdictLabel, type CheckVerdict } from "@/lib/migrationImport";
import type {
  MigrationAdvances, MigrationBatch, MigrationBatchDetail, MigrationChart, MigrationControlCheck, MigrationOpenItems, MigrationOpeningPosition, MigrationParties,
  MigrationReconciliationRecord, MigrationValidationRecord,
} from "@workspace/api-client-react";

// ── data ────────────────────────────────────────────────────────────────────

export const migrationKeys = {
  list: ["migration", "batches"] as const,
  batch: (id: number) => ["migration", "batch", id] as const,
  chart: (id: number) => ["migration", "chart", id] as const,
  parties: (id: number) => ["migration", "parties", id] as const,
  openItems: (id: number) => ["migration", "open-items", id] as const,
  advances: (id: number) => ["migration", "advances", id] as const,
  position: (id: number) => ["migration", "opening-position", id] as const,
  reversal: (id: number) => ["migration", "reversal-preview", id] as const,
};

/** Every query a staging write can move — the batch's status, the position, each set's problems. Invalidated together. */
export function invalidateMigration(qc: QueryClient, id: number) {
  qc.invalidateQueries({ queryKey: ["migration"] });
  qc.invalidateQueries({ queryKey: migrationKeys.batch(id) });
}

/** The stored validation / reconciliation records are typed by the contract (MigrationValidationRecord, MigrationReconciliationRecord). */
export type StoredValidation = MigrationValidationRecord;
export type StoredReconciliation = MigrationReconciliationRecord;

export function useBatch(id: number) {
  return useQuery<MigrationBatchDetail>({ queryKey: migrationKeys.batch(id), queryFn: () => apiFetch(`/migration/batches/${id}`), enabled: Number.isInteger(id) && id > 0 });
}
export function useChart(id: number, enabled = true) {
  return useQuery<MigrationChart>({ queryKey: migrationKeys.chart(id), queryFn: () => apiFetch(`/migration/batches/${id}/chart`), enabled });
}
export function useParties(id: number, enabled = true) {
  return useQuery<MigrationParties>({ queryKey: migrationKeys.parties(id), queryFn: () => apiFetch(`/migration/batches/${id}/parties`), enabled });
}
export function useOpenItems(id: number, enabled = true) {
  return useQuery<MigrationOpenItems>({ queryKey: migrationKeys.openItems(id), queryFn: () => apiFetch(`/migration/batches/${id}/open-items`), enabled });
}
export function useAdvances(id: number, enabled = true) {
  return useQuery<MigrationAdvances>({ queryKey: migrationKeys.advances(id), queryFn: () => apiFetch(`/migration/batches/${id}/advances`), enabled });
}
export function useOpeningPosition(id: number, enabled = true) {
  return useQuery<MigrationOpeningPosition>({ queryKey: migrationKeys.position(id), queryFn: () => apiFetch(`/migration/batches/${id}/opening-position`), enabled });
}

export const storedValidation = (b: MigrationBatchDetail | undefined): StoredValidation | null => (b?.validation && Array.isArray(b.validation.checks) ? b.validation : null);
export const storedReconciliation = (b: MigrationBatchDetail | undefined): StoredReconciliation | null => (b?.reconciliation && Array.isArray(b.reconciliation.checks) ? b.reconciliation : null);

/** Is the batch still a draft the operator may change? (validated is a draft that passed — any staging write re-opens it.) */
export const isEditable = (b: Pick<MigrationBatch, "status"> | undefined) => !!b && (b.status === "draft" || b.status === "validated");

// ── permissions ─────────────────────────────────────────────────────────────

/** Migration writes are ADMIN-only by the permission matrix; the accountant reads. For rendering only — the server decides. */
export function useCanRunMigration(): boolean {
  const { user } = useAuth();
  return user?.organizationRole === "admin";
}

export function MigrationPermissionHint() {
  const { t } = useLanguage();
  const can = useCanRunMigration();
  if (can) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="migration-permission-hint">
      {t("Staging, validating, committing and reversing a migration needs the admin role — you can review everything here, but not change it.",
         "يتطلب تجهيز الترحيل والتحقق منه واعتماده وعكسه دور المدير — يمكنك مراجعة كل شيء هنا دون تغييره.")}
    </p>
  );
}

// ── URL state ───────────────────────────────────────────────────────────────

export function useWorkspaceNav() {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const raw = params.get("section");
  const section: WorkspaceSection = (SECTIONS as readonly string[]).includes(raw ?? "") ? (raw as WorkspaceSection) : "overview";
  const focus = params.get("focus");
  const blockedOnly = params.get("blocked") === "1";
  const go = useCallback((next: WorkspaceSection, opts: { focus?: string | number | null; blocked?: boolean } = {}) => {
    const p = new URLSearchParams();
    p.set("section", next);
    if (opts.focus != null) p.set("focus", String(opts.focus));
    if (opts.blocked) p.set("blocked", "1");
    navigate(`${location.split("?")[0]}?${p.toString()}`);
  }, [location, navigate]);
  return { section, focus, blockedOnly, go };
}

/** Scroll the focused staging record into view once, and let the caller highlight it. */
export function useFocusRow(focus: string | null, ready: boolean) {
  useEffect(() => {
    if (!focus || !ready) return;
    const el = document.getElementById(`staged-${focus}`);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus, ready]);
}

// ── presentation ────────────────────────────────────────────────────────────

export function Money({ v, className, signed = false }: { v: number | string | null | undefined; className?: string; signed?: boolean }) {
  const n = Number(v ?? 0);
  // Latin digits and a fixed reading direction inside RTL text, so a column of amounts aligns.
  return <span dir="ltr" className={cn("font-mono tabular-nums whitespace-nowrap", className)}>{signed && n > 0 ? "+" : ""}{fmtNum(n)}</span>;
}

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  validated: "bg-info-surface/20 text-info",
  committed: "bg-positive-surface/20 text-positive",
  reversed: "bg-attention-surface/20 text-attention",
  discarded: "bg-secondary text-muted-foreground line-through",
};
export function statusLabel(status: string, lang: "en" | "ar"): string {
  const L: Record<string, [string, string]> = {
    draft: ["Draft", "مسودة"], validated: ["Validated", "تم التحقق"], committed: ["Committed", "معتمد"], reversed: ["Reversed", "معكوس"], discarded: ["Discarded", "مهمل"],
  };
  return (L[status] ?? [status, status])[lang === "ar" ? 1 : 0];
}
export function BatchStatusBadge({ status, testId = "batch-status" }: { status: string; testId?: string }) {
  const { lang } = useLanguage();
  return <Badge className={cn("text-xs", STATUS_STYLE[status] ?? "")} data-testid={testId}>{statusLabel(status, lang)}</Badge>;
}

const VERDICT_STYLE: Record<CheckVerdict, string> = {
  pass: "bg-positive-surface/20 text-positive",
  warn: "bg-attention-surface/20 text-attention",
  blocked: "bg-negative-surface/20 text-negative",
  skipped: "bg-secondary text-muted-foreground",
};
export function VerdictBadge({ check }: { check: Pick<MigrationControlCheck, "status"> }) {
  const { lang } = useLanguage();
  const v = verdictOf(check);
  const Icon = v === "pass" ? CheckCircle2 : v === "blocked" ? AlertTriangle : v === "warn" ? Info : CircleSlash;
  return <Badge className={cn("gap-1 text-xs", VERDICT_STYLE[v])} data-verdict={v}><Icon className="w-3 h-3" />{verdictLabel(v, lang)}</Badge>;
}

/** A staging row's server-computed problems. Empty = the row is fine today. */
export function Problems({ list, id }: { list: string[]; id?: string | number }) {
  const { t } = useLanguage();
  if (list.length === 0) return <span className="text-xs text-positive" data-testid={id != null ? `ok-${id}` : undefined}>{t("OK", "سليم")}</span>;
  return (
    <ul className="text-xs text-negative space-y-0.5" data-testid={id != null ? `problems-${id}` : undefined}>
      {list.map((p, i) => <li key={i} className="flex gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /><span>{p}</span></li>)}
    </ul>
  );
}

export function EmptyState({ icon: Icon, title, hint, action }: { icon: React.ElementType; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="text-center py-10 text-muted-foreground" data-testid="empty-state">
      <Icon className="w-8 h-8 mx-auto mb-3 opacity-40" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="text-xs mt-1 max-w-md mx-auto">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A small key/value grid for a record's facts. */
export function Facts({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="flex flex-col sm:flex-row sm:items-baseline sm:gap-2 min-w-0">
          <dt className="text-xs text-muted-foreground sm:w-44 shrink-0">{k}</dt>
          <dd className="min-w-0 break-words">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Row highlight for the focused record. */
export const focusClass = (id: number | string, focus: string | null) => (focus != null && String(id) === focus ? "ring-2 ring-primary/60 bg-primary/5" : "");

/** The blocking summary of a validation, for headers. */
export function useValidationSummary(batch: MigrationBatchDetail | undefined) {
  const qc = useQueryClient();
  void qc;
  const v = storedValidation(batch);
  const blocking = v ? v.checks.filter((c) => c.status === "fail").length : null;
  const warnings = v ? v.checks.filter((c) => c.status === "warn").length : null;
  return { validation: v, blocking, warnings };
}

export const SECTION_LABELS: Record<WorkspaceSection, [string, string]> = {
  overview: ["Overview", "نظرة عامة"],
  chart: ["Chart of Accounts", "دليل الحسابات"],
  parties: ["Customers & Suppliers", "العملاء والموردون"],
  ar: ["AR Open Items", "الذمم المدينة المفتوحة"],
  ap: ["AP Open Items", "الذمم الدائنة المفتوحة"],
  advances: ["Customer Advances", "دفعات العملاء المقدمة"],
  banks: ["Bank Opening Balances", "أرصدة البنوك الافتتاحية"],
  vat: ["VAT & Tax Balances", "أرصدة الضريبة"],
  "trial-balance": ["Opening Trial Balance", "ميزان المراجعة الافتتاحي"],
  reconciliation: ["Reconciliation R1–R10", "المطابقة R1–R10"],
  validation: ["Validation", "التحقق"],
  commit: ["Commit / History", "الاعتماد / السجل"],
};
