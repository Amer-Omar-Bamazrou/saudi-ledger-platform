/**
 * Batch 1C — the three balance views, all read from ONE server answer
 * (`/opening-position`): the bank opening balances (R4), the VAT position
 * (R9) and the opening trial balance with its difference (A5: a non-zero
 * difference blocks; nothing offers to balance it).
 */
import { Fragment, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Landmark, Receipt, Scale } from "lucide-react";
import { groupByType } from "@/lib/migrationImport";
import { EmptyState, Money, VerdictBadge, invalidateMigration, useCanRunMigration, useOpeningPosition, useWorkspaceNav } from "./shared";
import type { MigrationBatchDetail, MigrationOpeningPosition, MigrationVatPosition, UpdateMigrationBatchInput } from "@workspace/api-client-react";

function Control({ position, id }: { position: MigrationOpeningPosition; id: string }) {
  const c = position.controls.find((x) => x.id === id);
  if (!c) return null;
  return (
    <div className="rounded-md border border-border p-3 text-sm flex flex-wrap items-start gap-2" data-testid={`control-${id}`}>
      <VerdictBadge check={c} />
      <div className="min-w-0 flex-1"><p className="font-medium">{c.title}</p><p className="text-xs text-muted-foreground break-words">{c.detail}</p></div>
    </div>
  );
}

// ── banks ───────────────────────────────────────────────────────────────────

export function BanksSection({ batchId, openingDate }: { batchId: number; openingDate: string }) {
  const { t } = useLanguage();
  const { go } = useWorkspaceNav();
  const { data, isLoading, error } = useOpeningPosition(batchId);
  if (isLoading) return <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (error || !data) return <p className="text-sm text-destructive p-4">{t("The opening position could not be loaded.", "تعذر تحميل المركز الافتتاحي.")} {(error as Error)?.message}</p>;
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t("Bank opening balances", "أرصدة البنوك الافتتاحية")}</h2>
        <p className="text-sm text-muted-foreground">{t(`Each old bank row mapped to one of this company's bank accounts, with the old chart's closing balance at ${openingDate}. The balance lands on the bank's own GL cash account at commit — nothing moves while you review or stage.`, `كل صف بنكي قديم مربوط بأحد الحسابات البنكية لهذه الشركة، برصيده الختامي في الدليل السابق بتاريخ ${openingDate}. يستقر الرصيد على حساب النقد الخاص بالبنك في دفتر الأستاذ عند الاعتماد — ولا يتحرك شيء أثناء المراجعة أو التجهيز.`)}</p>
      </div>
      <Control position={data} id="BANKS" />
      {data.banks.length === 0 ? (
        <EmptyState icon={Landmark} title={t("No bank row is mapped yet", "لم يُربط أي صف بنكي بعد")} hint={t("Map the old bank accounts to this company's bank accounts on the Chart of Accounts section (decision: map to bank account).", "اربط الحسابات البنكية القديمة بحسابات الشركة البنكية في قسم دليل الحسابات (القرار: ربط بحساب بنكي).")}
          action={<Button size="sm" variant="outline" onClick={() => go("chart")}>{t("Go to the chart", "الانتقال إلى الدليل")}</Button>} />
      ) : (
        <Card><CardContent className="pt-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{[t("Bank account", "الحساب البنكي"), t("Old code", "الرمز القديم"), t("Opening balance", "الرصيد الافتتاحي"), t("Typed on the bank record", "المدخل على سجل البنك"), t("Advances inside", "دفعات مقدمة ضمنه"), t("Evidence", "الإثبات")].map((h, i) => <th key={i} className="text-start pb-2 pe-3 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {data.banks.map((b) => (
                  <tr key={b.bankAccountId} className="border-b border-border/50 align-top" data-testid={`bank-row-${b.sourceCode}`}>
                    <td className="py-2 pe-3">{b.bankName}<span className="block text-[11px] text-muted-foreground">#{b.bankAccountId}{b.leafCategoryId == null && <span className="text-negative"> · {t("no GL cash account", "بلا حساب نقد في الدفتر")}</span>}</span></td>
                    <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{b.sourceCode}</td>
                    <td className="py-2 pe-3 text-end"><Money v={b.balance} className="font-semibold" /></td>
                    <td className="py-2 pe-3 text-end">{b.typedOpeningBalance != null ? <Money v={b.typedOpeningBalance} className={Math.abs(b.typedOpeningBalance - b.balance) > 0.005 && b.typedOpeningBalance !== 0 ? "text-negative" : ""} /> : "—"}</td>
                    <td className="py-2 pe-3 text-end"><Money v={b.advancesInside} /></td>
                    <td className="py-2 pe-3 text-xs max-w-[16rem] break-words">{b.evidenceNote ?? <span className="text-negative">{t("missing — a bank balance needs its statement evidence", "مفقود — يحتاج رصيد البنك إلى إثبات من كشف الحساب")}</span>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="font-semibold border-t border-border"><td className="py-2 pe-3" colSpan={2}>{t("Total", "الإجمالي")}</td><td className="py-2 pe-3 text-end"><Money v={data.banks.reduce((s, b) => s + b.balance, 0)} /></td><td colSpan={3} /></tr></tfoot>
            </table>
          </div>
        </CardContent></Card>
      )}
    </div>
  );
}

// ── VAT ─────────────────────────────────────────────────────────────────────

export function VatSection({ batch, editable }: { batch: MigrationBatchDetail; editable: boolean }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const canRun = useCanRunMigration();
  const { data, isLoading, error } = useOpeningPosition(batch.id);
  const vp = batch.vatPosition;
  const [form, setForm] = useState<Record<string, string>>({
    returnReference: vp?.returnReference ?? "", periodStart: vp?.periodStart ?? "", periodEnd: vp?.periodEnd ?? "",
    outputVatPayable: vp != null ? String(vp.outputVatPayable) : "", inputVatReceivable: vp != null ? String(vp.inputVatReceivable) : "", note: vp?.note ?? "",
  });
  const can = editable && canRun;
  const mut = useMutation({
    mutationFn: (vatPosition: MigrationVatPosition | null) => apiFetch(`/migration/batches/${batch.id}`, { method: "PATCH", body: JSON.stringify({ vatPosition } satisfies UpdateMigrationBatchInput) }),
    onSuccess: () => { invalidateMigration(qc, batch.id); toast({ title: t("VAT position saved", "تم حفظ الموقف الضريبي") }); },
  });
  const valid = form.returnReference.trim() && /^\d{4}-\d{2}-\d{2}$/.test(form.periodStart) && /^\d{4}-\d{2}-\d{2}$/.test(form.periodEnd) && Number.isFinite(Number(form.outputVatPayable)) && Number.isFinite(Number(form.inputVatReceivable)) && form.outputVatPayable !== "" && form.inputVatReceivable !== "";

  const vatOut = data?.lines.filter((l) => l.systemCode === "VAT_OUTPUT") ?? [];
  const vatIn = data?.lines.filter((l) => l.systemCode === "VAT_INPUT") ?? [];
  const sum = (ls: typeof vatOut, side: "debit" | "credit") => ls.reduce((s, l) => s + l[side] - l[side === "debit" ? "credit" : "debit"], 0);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t("VAT & tax balances at the opening date", "أرصدة الضريبة في تاريخ الافتتاح")}</h2>
        <p className="text-sm text-muted-foreground">{t("The HISTORICAL VAT position: what the previous system's last return left payable and recoverable. It is carried as a balance and reconciled to that return (R9). Migration creates no VAT event and nothing here appears in a Saudi Ledger VAT return.", "الموقف الضريبي التاريخي: ما تركه آخر إقرار للنظام السابق مستحقًا ومستردًا. يُنقل كرصيد ويُطابَق مع ذلك الإقرار (R9). لا يُنشئ الترحيل أي حدث ضريبي ولا يظهر شيء هنا في إقرار Saudi Ledger الضريبي.")}</p>
      </div>
      {isLoading ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p> : error || !data ? <p className="text-sm text-destructive">{(error as Error)?.message}</p> : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Card><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{t("Opening output VAT (payable)", "ضريبة المخرجات الافتتاحية (مستحقة)")}</CardTitle></CardHeader><CardContent><div className="text-lg font-semibold" data-testid="vat-output"><Money v={sum(vatOut, "credit")} /></div><p className="text-[11px] text-muted-foreground" dir="ltr">{vatOut.flatMap((l) => l.sourceCodes).join(", ") || "—"}</p></CardContent></Card>
            <Card><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{t("Opening input VAT (recoverable)", "ضريبة المدخلات الافتتاحية (مستردة)")}</CardTitle></CardHeader><CardContent><div className="text-lg font-semibold" data-testid="vat-input"><Money v={sum(vatIn, "debit")} /></div><p className="text-[11px] text-muted-foreground" dir="ltr">{vatIn.flatMap((l) => l.sourceCodes).join(", ") || "—"}</p></CardContent></Card>
          </div>
          <Control position={data} id="VAT_POSITION" />
        </>
      )}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Receipt className="w-4 h-4" />{t("The last filed return (reference)", "آخر إقرار مقدَّم (المرجع)")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">{t("Required when a VAT balance is staged: the return's reference, its period (ending on or before the opening date) and its closing output / input position. The staged balances must agree with it.", "مطلوب عند تجهيز رصيد ضريبي: مرجع الإقرار وفترته (المنتهية في تاريخ الافتتاح أو قبله) وموقفه الختامي للمخرجات / المدخلات. يجب أن تتفق الأرصدة المجهّزة معه.")}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {([["returnReference", t("Return reference / acknowledgement", "مرجع الإقرار / رقم الإشعار"), "text"], ["periodStart", t("Period start", "بداية الفترة"), "date"], ["periodEnd", t("Period end", "نهاية الفترة"), "date"], ["outputVatPayable", t("Output VAT payable at cut-off", "ضريبة المخرجات المستحقة عند القطع"), "number"], ["inputVatReceivable", t("Input VAT recoverable at cut-off", "ضريبة المدخلات المستردة عند القطع"), "number"], ["note", t("Note", "ملاحظة"), "text"]] as const).map(([k, label, type]) => (
              <div key={k}><Label className="text-xs text-muted-foreground" htmlFor={`vat-${k}`}>{label}</Label><Input id={`vat-${k}`} type={type} step={type === "number" ? "0.01" : undefined} dir={type === "text" ? undefined : "ltr"} value={form[k]} disabled={!can} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} className="mt-1 h-9 text-sm" data-testid={`vat-${k}`} /></div>
            ))}
          </div>
          {can && (
            <div className="flex gap-2 justify-end">
              {vp && <Button variant="ghost" size="sm" disabled={mut.isPending} onClick={() => mut.mutate(null)}>{t("Clear", "مسح")}</Button>}
              <Button size="sm" disabled={!valid || mut.isPending} onClick={() => mut.mutate({ returnReference: form.returnReference.trim(), periodStart: form.periodStart, periodEnd: form.periodEnd, outputVatPayable: Number(form.outputVatPayable), inputVatReceivable: Number(form.inputVatReceivable), note: form.note.trim() || null })} data-testid="vat-save">{mut.isPending ? t("Saving…", "جارٍ الحفظ…") : t("Save VAT position", "حفظ الموقف الضريبي")}</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── trial balance ───────────────────────────────────────────────────────────

export function TrialBalanceSection({ batchId, openingDate }: { batchId: number; openingDate: string }) {
  const { t, lang } = useLanguage();
  const { go } = useWorkspaceNav();
  const { data, isLoading, error } = useOpeningPosition(batchId);
  if (isLoading) return <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (error || !data) return <p className="text-sm text-destructive p-4">{t("The opening position could not be loaded.", "تعذر تحميل المركز الافتتاحي.")} {(error as Error)?.message}</p>;
  const groups = groupByType(data.lines);
  const tot = data.totals;
  const typeLabel: Record<string, [string, string]> = { asset: ["Assets", "الأصول"], liability: ["Liabilities", "الالتزامات"], equity: ["Equity", "حقوق الملكية"], income: ["Revenue / YTD income", "الإيرادات / إيراد السنة حتى تاريخه"], expense: ["Expenses / YTD", "المصروفات / حتى تاريخه"] };
  const control = (code: string) => data.lines.filter((l) => l.systemCode === code).reduce((s, l) => s + l.balance, 0);
  const balanced = Math.abs(tot.difference) < 0.005;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t(`Opening trial balance as at ${openingDate}`, `ميزان المراجعة الافتتاحي كما في ${openingDate}`)}</h2>
        <p className="text-sm text-muted-foreground">{t("The staged chart, mapped onto the accounts it will post to. Read only — every figure is the server's. The commit posts exactly this, or nothing.", "الدليل المجهّز مربوطًا بالحسابات التي سيُرحَّل إليها. للقراءة فقط — كل رقم من الخادم. يُرحّل الاعتماد هذا بالضبط أو لا شيء.")}</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{t("Total debits", "إجمالي المدين")}</CardTitle></CardHeader><CardContent><div className="text-xl font-semibold" data-testid="tb-debit"><Money v={tot.debit} /></div></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{t("Total credits", "إجمالي الدائن")}</CardTitle></CardHeader><CardContent><div className="text-xl font-semibold" data-testid="tb-credit"><Money v={tot.credit} /></div></CardContent></Card>
        <Card className={balanced ? "border-positive/50" : "border-negative/60"}><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{t("Difference (unclassified)", "الفرق (غير مصنَّف)")}</CardTitle></CardHeader><CardContent><div className={`text-xl font-semibold ${balanced ? "text-positive" : "text-negative"}`} data-testid="tb-difference"><Money v={tot.difference} /></div><p className="text-[11px] text-muted-foreground mt-1">{balanced ? t("Debits equal credits on named accounts.", "المدين يساوي الدائن على حسابات مُسمّاة.") : t("Must be zero to commit. Classify it into named accounts in the chart — there is no balancing account and no automatic balancing.", "يجب أن يكون صفرًا للاعتماد. صنّفه في حسابات مُسمّاة في الدليل — لا يوجد حساب موازنة ولا موازنة تلقائية.")}</p></CardContent></Card>
      </div>
      {!balanced && <div className="text-sm rounded-md border border-negative/40 bg-negative-surface/10 p-3" data-testid="tb-unbalanced-notice">{t(`The opening position is off by ${Math.abs(tot.difference).toFixed(2)} ${tot.difference < 0 ? "on the debit side" : "on the credit side"}. The commit refuses this (A5). `, `المركز الافتتاحي يختلف بمقدار ${Math.abs(tot.difference).toFixed(2)} ${tot.difference < 0 ? "في جانب المدين" : "في جانب الدائن"}. يرفض الاعتماد ذلك (A5). `)}<button className="underline" onClick={() => go("chart", { blocked: true })}>{t("Review the chart", "مراجعة الدليل")}</button></div>}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Scale className="w-4 h-4" />{t("By account", "حسب الحساب")}</CardTitle></CardHeader>
        <CardContent>
          {data.lines.length === 0 ? <p className="text-sm text-muted-foreground">{t("Nothing mapped yet.", "لم يُربط شيء بعد.")}</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs sm:text-sm">
                <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase"><th className="text-start pb-2 pe-3 font-medium">{t("Account", "الحساب")}</th><th className="text-start pb-2 pe-3 font-medium hidden sm:table-cell">{t("From old codes", "من الرموز القديمة")}</th><th className="text-end pb-2 pe-3 font-medium">{t("Debit", "مدين")}</th><th className="text-end pb-2 font-medium">{t("Credit", "دائن")}</th></tr></thead>
                <tbody>
                  {groups.filter((g) => g.rows.length > 0).map((g) => (
                    <Fragment key={g.type}>
                      <tr className="bg-secondary/30"><td className="py-1.5 pe-3 font-semibold text-xs uppercase">{typeLabel[g.type][lang === "ar" ? 1 : 0]}</td><td className="hidden sm:table-cell" /><td className="py-1.5 pe-3 text-end font-semibold"><Money v={g.debit} /></td><td className="py-1.5 text-end font-semibold"><Money v={g.credit} /></td></tr>
                      {g.rows.map((l) => (
                        <tr key={l.target} className="border-b border-border/40" data-testid={`tb-line-${l.target}`}>
                          <td className="py-1.5 pe-3">{l.accountName}{l.systemCode && <span className="ms-1 text-[11px] text-muted-foreground font-mono">{l.systemCode}</span>}{l.targetKind === "create" && <span className="ms-1 text-[11px] text-muted-foreground">({t("new", "جديد")})</span>}</td>
                          <td className="py-1.5 pe-3 font-mono text-[11px] text-muted-foreground hidden sm:table-cell" dir="ltr">{l.sourceCodes.join(", ")}</td>
                          <td className="py-1.5 pe-3 text-end"><Money v={l.debit} /></td>
                          <td className="py-1.5 text-end"><Money v={l.credit} /></td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot><tr className="font-semibold border-t-2 border-border"><td className="py-2 pe-3">{t("Total", "الإجمالي")}</td><td className="hidden sm:table-cell" /><td className="py-2 pe-3 text-end"><Money v={tot.debit} /></td><td className="py-2 text-end"><Money v={tot.credit} /></td></tr></tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">{t("Control balances", "أرصدة المراقبة")}</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <tbody>
                {[[t("Receivables (AR)", "الذمم المدينة (AR)"), control("AR")], [t("Payables (AP)", "الذمم الدائنة (AP)"), control("AP")], [t("Customer deposits", "دفعات العملاء المقدمة"), control("CUSTOMER_DEPOSITS")], [t("Output VAT", "ضريبة المخرجات"), control("VAT_OUTPUT")], [t("Input VAT", "ضريبة المدخلات"), control("VAT_INPUT")], [t("Bank balances", "أرصدة البنوك"), data.banks.reduce((s, b) => s + b.balance, 0)], [t("YTD income", "إيراد السنة حتى تاريخه"), tot.ytdIncome], [t("YTD expense", "مصروف السنة حتى تاريخه"), tot.ytdExpense], [t("YTD result", "نتيجة السنة حتى تاريخه"), tot.ytdResult]].map(([l, v], i) => (
                  <tr key={i} className="border-b border-border/40"><td className="py-1.5 text-muted-foreground">{l}</td><td className="py-1.5 text-end"><Money v={v as number} /></td></tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-muted-foreground mt-2">{t("Balances are shown as debit − credit (a liability reads negative).", "تُعرض الأرصدة مدين − دائن (الالتزام يظهر سالبًا).")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">{t("Subledgers by party", "الدفاتر المساعدة حسب الطرف")}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {[[t("AR by customer", "الذمم المدينة حسب العميل"), data.arByCustomer], [t("AP by supplier", "الذمم الدائنة حسب المورّد"), data.apByVendor], [t("Deposits by customer", "الدفعات المقدمة حسب العميل")], ].map(([l], i) => {
              const list = i === 0 ? data.arByCustomer : i === 1 ? data.apByVendor : data.depositsByCustomer;
              return (
                <div key={i}>
                  <p className="text-xs text-muted-foreground mb-1">{l as string} · <Money v={list.reduce((s, p) => s + p.total, 0)} /></p>
                  {list.length === 0 ? <p className="text-xs text-muted-foreground">—</p> : (
                    <ul className="space-y-0.5">{list.map((p) => <li key={p.partySourceId} className="flex justify-between gap-2"><span className="truncate">{p.partyName ?? p.partySourceId} <span className="text-[11px] text-muted-foreground">({p.items})</span></span><Money v={p.total} /></li>)}</ul>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
