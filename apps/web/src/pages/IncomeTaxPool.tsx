/**
 * THE INCOME TAX LAW ART. 17 POOL — the working paper (FA-E, 2026-09-22).
 *
 * Record: docs/product/fixed-assets-decision-pack.md §24.
 *
 * 🔴 This page shows a SECOND basis, and says so before it shows a figure. The
 * book register on /assets is the IFRS basis, and it is the Zakat basis too
 * (Zakat Regulations Art. 48(1)(b), 63(2)). Income tax is pooled, declining
 * balance, by group — a different number for the same assets, and a reader who
 * thinks these two should agree will chase a difference that is correct.
 *
 * 🔴 It renders a REFUSAL as an explanation, never as an empty table. Four
 * states stop the computation (the regime undeclared, a Zakat-only company, no
 * fiscal year, no anchor) and each one names the act that resolves it — a
 * zeroed table would read exactly like a company with no assets.
 *
 * 🔴 The elections are shown as OFFERS. Art. 17(h) and 17(i) both say "may",
 * and taking one rewrites every later year of the chain, so the checkbox is the
 * taxpayer's act and the page states what it is worth before it is taken.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Scale, Info, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { Link } from "wouter";
import type { IncomeTaxPoolReport, IncomeTaxPoolGroupYear, IncomeTaxPoolDeclaration } from "@workspace/api-client-react";

const GROUP_LABELS: Record<number, [string, string]> = {
  1: ["Stationary buildings", "المباني الثابتة"],
  2: ["Movable industrial and agricultural buildings", "المباني الصناعية والزراعية المتنقلة"],
  3: ["Factories, machines, equipment, vehicles, hardware & software", "المصانع والآلات والمعدات والمركبات والأجهزة والبرامج"],
  4: ["Geological surveying and exploration", "المسح الجيولوجي والتنقيب"],
  5: ["All other tangible and intangible assets", "سائر الأصول الملموسة وغير الملموسة"],
};

const Money = ({ v, className = "" }: { v: number; className?: string }) => (
  <span className={`font-mono ${className}`} dir="ltr">{fmtNum(v)}</span>
);

export default function IncomeTaxPool() {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ group: number; taxYear: number } | null>(null);

  const { data, isLoading, error } = useQuery<IncomeTaxPoolReport>({ queryKey: ["income-tax-pool"], queryFn: () => apiFetch("/assets/income-tax-pool") });
  const { data: decls } = useQuery<{ items: IncomeTaxPoolDeclaration[] }>({ queryKey: ["income-tax-pool", "declarations"], queryFn: () => apiFetch("/assets/income-tax-pool/declarations") });

  const declare = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiFetch("/assets/income-tax-pool/declarations", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["income-tax-pool"] });
      setEditing(null);
      toast({ title: t("Declaration recorded", "تم تسجيل الإقرار") });
    },
    onError: (e: Error) => toast({ title: t("Not recorded", "لم يُسجّل"), description: e.message, variant: "destructive" }),
  });

  const groupName = (g: number) => (lang === "ar" ? GROUP_LABELS[g]?.[1] : GROUP_LABELS[g]?.[0]) ?? `${g}`;

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</div>;
  if (error || !data) return <div className="p-6 text-sm text-destructive">{t("The pool could not be loaded.", "تعذر تحميل الوعاء.")} {(error as Error)?.message}</div>;

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-full" data-testid="page-income-tax-pool">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><Scale className="w-6 h-6" />{t("Income tax — Art. 17 depreciation pool", "ضريبة الدخل — وعاء الإهلاك وفق المادة 17")}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          {t("A working paper, not an entry: nothing here posts to the ledger. Income Tax Law Art. 17 depreciates assets POOLED by group on a declining balance, which is a different figure from the book depreciation on the register — and the book figure is the one Zakat uses (Zakat Regulations Art. 48(1)(b), 63(2)). The two are meant to disagree.",
             "ورقة عمل لا قيد: لا يُرحَّل شيء هنا إلى دفتر الأستاذ. تُهلك المادة 17 من نظام ضريبة الدخل الأصول بطريقة الوعاء لكل مجموعة على أساس الرصيد المتناقص، وهو رقم يختلف عن الإهلاك الدفتري في السجل — والرقم الدفتري هو ما تعتمده الزكاة (لائحة الزكاة المادتان 48(1)(ب) و63(2)). والاختلاف بينهما مقصود.")}
        </p>
        <Link href="/assets" className="text-sm text-primary hover:underline" data-testid="link-register">{t("The book register →", "السجل الدفتري ←")}</Link>
      </div>

      {data.status !== "computed" ? (
        <Card data-testid="pool-blocked">
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Info className="w-4 h-4" />{t("No figures yet — and this is not an empty pool", "لا توجد أرقام بعد — وليس هذا وعاءً فارغًا")}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Badge variant="outline" data-testid="pool-status">{data.status}</Badge>
            <p className="text-sm" data-testid="pool-reason">{data.reason}</p>
            {data.status === "anchor_not_declared" && <AnchorForm onSubmit={(b) => declare.mutate(b)} busy={declare.isPending} t={t} groupName={groupName} />}
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="pool-anchor">
            {t(`Chained from the declared position at the end of ${data.anchorYear}. Non-Saudi/non-GCC share: ${data.foreignOwnershipPct}%.`,
               `متسلسل من المركز المُقر في نهاية ${data.anchorYear}. حصة غير السعوديين/غير الخليجيين: ${data.foreignOwnershipPct}%.`)}
          </p>
          {data.years.map((y) => (
            <Card key={y.taxYear} data-testid={`pool-year-${y.taxYear}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t(`Tax year ${y.taxYear}`, `السنة الضريبية ${y.taxYear}`)}
                  <span className="ms-2 text-xs font-normal text-muted-foreground" dir="ltr">{y.startDate} → {y.endDate}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                      {[t("Group", "المجموعة"), t("Rate", "المعدل"), t("Opening", "الرصيد الافتتاحي"), t("+50% additions", "+50% الإضافات"), t("−50% disposals", "−50% الاستبعادات"), t("Art. 18 into pool", "المادة 18 إلى الوعاء"), t("Balance", "الرصيد"), t("Deduction", "الحسم"), t("Closing", "الرصيد الختامي"), ""].map((h, i) => (
                        <th key={i} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {y.groups.map((g) => (
                      <GroupRow key={g.group} g={g} year={y.taxYear} name={groupName(g.group)} t={t} onEdit={() => setEditing({ group: g.group, taxYear: y.taxYear })} />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-semibold border-t border-border">
                      <td className="py-2 pe-3" colSpan={7}>{t("Total deduction for the year", "إجمالي الحسم للسنة")}</td>
                      <td className="py-2 pe-3 text-end" data-testid={`pool-total-${y.taxYear}`}><Money v={y.groups.reduce((s, g) => s + g.totalDeduction, 0)} /></td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
                {y.groups.some((g) => g.excessTaxableIncome > 0) && (
                  <p className="text-xs text-warning mt-2" data-testid={`pool-excess-${y.taxYear}`}>
                    {t("Art. 17(g): 50 % of the disposal compensation exceeded the group balance, so the group is reduced to zero and the excess is TAXABLE INCOME — it is not a deduction.",
                       "المادة 17(ز): تجاوز 50% من تعويض الاستبعادات رصيد المجموعة، فيُخفَّض الرصيد إلى صفر ويُدرج الفائض ضمن الدخل الخاضع للضريبة — وليس حسمًا.")}
                    {" "}<Money v={y.groups.reduce((s, g) => s + g.excessTaxableIncome, 0)} />
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </>
      )}

      <Card data-testid="pool-frame">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("What this working paper does NOT cover", "ما لا تغطيه ورقة العمل هذه")}</CardTitle></CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-2">
            {t("The frame is part of the figure. Art. 17 contemplates these, and the register holds nothing that would let the platform compute them — so they are stated rather than silently left out.",
               "الإطار جزء من الرقم. تتناول المادة 17 هذه الحالات، ولا يحمل السجل ما يتيح حسابها — ولذلك تُذكر صراحةً بدل إغفالها.")}
          </p>
          <ul className="space-y-1 text-xs">
            {data.frameLimits.map((f) => (
              <li key={f.article} className="flex gap-2"><span className="font-mono shrink-0" dir="ltr">{f.article}</span><span className="text-muted-foreground">{f.limit}</span></li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {decls && decls.items.length > 0 && (
        <Card data-testid="pool-declarations">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("What the taxpayer declared", "ما أقرّ به المكلف")}</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">
                {[t("Year", "السنة"), t("Group", "المجموعة"), t("Opening balance", "الرصيد الافتتاحي"), t("Additions", "الإضافات"), t("Disposals", "الاستبعادات"), t("Art. 18 repairs", "إصلاحات المادة 18"), t("Elections", "الخيارات")].map((h, i) => <th key={i} className="text-start pb-2 pe-3 font-medium">{h}</th>)}
              </tr></thead>
              <tbody>
                {decls.items.map((d) => (
                  <tr key={d.id} className="border-b border-border/50" data-testid={`declaration-${d.incomeTaxGroup}-${d.taxYear}`}>
                    <td className="py-2 pe-3 font-mono" dir="ltr">{d.taxYear}</td>
                    <td className="py-2 pe-3">{d.incomeTaxGroup} — {groupName(d.incomeTaxGroup)}</td>
                    <td className="py-2 pe-3 text-end">{d.closingBalanceDeclared == null ? "—" : <Money v={d.closingBalanceDeclared} />}</td>
                    <td className="py-2 pe-3 text-end">{d.additionsDeclared == null ? "—" : <Money v={d.additionsDeclared} />}</td>
                    <td className="py-2 pe-3 text-end">{d.disposalsDeclared == null ? "—" : <Money v={d.disposalsDeclared} />}</td>
                    <td className="py-2 pe-3 text-end">{d.repairsDeclared == null ? t("not declared", "غير مُقرّ") : <Money v={d.repairsDeclared} />}</td>
                    <td className="py-2 pe-3 text-xs">{[d.electSmallBalanceWriteOff ? "17(h)" : null, d.electGroupClosedWriteOff ? "17(i)" : null].filter(Boolean).join(" · ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {editing && (
        <YearDeclarationDialog
          group={editing.group}
          taxYear={editing.taxYear}
          name={groupName(editing.group)}
          existing={decls?.items.find((d) => d.incomeTaxGroup === editing.group && d.taxYear === editing.taxYear) ?? null}
          row={data.years.find((y) => y.taxYear === editing.taxYear)?.groups.find((g) => g.group === editing.group) ?? null}
          busy={declare.isPending}
          t={t}
          onClose={() => setEditing(null)}
          onSubmit={(b) => declare.mutate(b)}
        />
      )}
    </div>
  );
}

function GroupRow({ g, year, name, t, onEdit }: { g: IncomeTaxPoolGroupYear; year: number; name: string; t: (en: string, ar: string) => string; onEdit: () => void }) {
  const offered = (g.elections.groupClosed.available && !g.elections.groupClosed.taken) || (g.elections.smallBalance.available && !g.elections.smallBalance.taken);
  return (
    <tr className="border-b border-border/50 align-top" data-testid={`pool-row-${year}-${g.group}`}>
      <td className="py-2 pe-3"><span className="font-medium">{g.group}</span><span className="block text-[11px] text-muted-foreground">{name}</span></td>
      <td className="py-2 pe-3 font-mono" dir="ltr">{g.ratePct}%</td>
      <td className="py-2 pe-3 text-end"><Money v={g.openingBalance} /></td>
      <td className="py-2 pe-3 text-end" data-testid={`pool-add-${year}-${g.group}`}><Money v={g.additionsHalf} /></td>
      <td className="py-2 pe-3 text-end"><Money v={g.disposalsHalf} /></td>
      <td className="py-2 pe-3 text-end">
        {g.repairsNotDeclared
          ? <span className="text-[11px] text-muted-foreground" data-testid={`pool-repairs-undeclared-${year}-${g.group}`}>{t("not declared", "غير مُقرّ")}</span>
          : <Money v={g.repairs.addedToPool} />}
      </td>
      <td className="py-2 pe-3 text-end"><Money v={g.balanceBeforeDeduction} /></td>
      <td className="py-2 pe-3 text-end font-semibold" data-testid={`pool-deduction-${year}-${g.group}`}><Money v={g.totalDeduction} /></td>
      <td className="py-2 pe-3 text-end"><Money v={g.closingBalance} /></td>
      <td className="py-2">
        <div className="flex flex-col items-end gap-1">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onEdit} data-testid={`pool-declare-${year}-${g.group}`}><Pencil className="w-3 h-3 me-1" />{t("Declare", "إقرار")}</Button>
          {offered && (
            <span className="text-[11px] text-primary" data-testid={`pool-election-offer-${year}-${g.group}`}>
              {g.elections.groupClosed.available
                ? t(`Art. 17(i) available: ${fmtNum(g.elections.groupClosed.amount)} may be deducted`, `متاح وفق المادة 17(ط): يجوز حسم ${fmtNum(g.elections.groupClosed.amount)}`)
                : t(`Art. 17(h) available: ${fmtNum(g.elections.smallBalance.amount)} may be deducted`, `متاح وفق المادة 17(ح): يجوز حسم ${fmtNum(g.elections.smallBalance.amount)}`)}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

/** The anchor — the one input the platform can never derive. */
function AnchorForm({ onSubmit, busy, t, groupName }: { onSubmit: (b: Record<string, unknown>) => void; busy: boolean; t: (en: string, ar: string) => string; groupName: (g: number) => string }) {
  const [group, setGroup] = useState("3");
  const [taxYear, setTaxYear] = useState(String(new Date().getUTCFullYear() - 1));
  const [balance, setBalance] = useState("0");
  const [additions, setAdditions] = useState("0");
  const [disposals, setDisposals] = useState("0");
  return (
    <div className="space-y-3 border-t border-border pt-3" data-testid="anchor-form">
      <p className="text-xs text-muted-foreground">
        {t("Take these from the LAST FILED return: the group's balance after that year's deduction, and that year's own additions and disposals — Art. 17(e) carries 50 % of them into the following year. If the company has no pool history, declare zeros; that is a statement, not a blank.",
           "خذ هذه الأرقام من آخر إقرار مقدَّم: رصيد المجموعة بعد حسم تلك السنة، وإضافات واستبعادات تلك السنة نفسها — إذ تنقل المادة 17(هـ) 50% منها إلى السنة التالية. وإن لم يكن للمنشأة تاريخ وعاء، فأقرّ بأصفار؛ فذلك إفادة لا فراغ.")}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
        <div><Label className="text-xs">{t("Group", "المجموعة")}</Label>
          <Select value={group} onValueChange={setGroup}><SelectTrigger data-testid="anchor-group"><SelectValue /></SelectTrigger>
            <SelectContent>{[1, 2, 3, 4, 5].map((g) => <SelectItem key={g} value={String(g)}>{g} — {groupName(g)}</SelectItem>)}</SelectContent>
          </Select></div>
        <div><Label className="text-xs">{t("Tax year", "السنة الضريبية")}</Label><Input value={taxYear} onChange={(e) => setTaxYear(e.target.value)} data-testid="anchor-year" dir="ltr" /></div>
        <div><Label className="text-xs">{t("Closing balance", "الرصيد الختامي")}</Label><Input value={balance} onChange={(e) => setBalance(e.target.value)} data-testid="anchor-balance" dir="ltr" /></div>
        <div><Label className="text-xs">{t("Additions that year", "إضافات تلك السنة")}</Label><Input value={additions} onChange={(e) => setAdditions(e.target.value)} data-testid="anchor-additions" dir="ltr" /></div>
        <div><Label className="text-xs">{t("Disposals that year", "استبعادات تلك السنة")}</Label><Input value={disposals} onChange={(e) => setDisposals(e.target.value)} data-testid="anchor-disposals" dir="ltr" /></div>
      </div>
      <Button
        size="sm"
        disabled={busy}
        data-testid="anchor-submit"
        onClick={() => onSubmit({ incomeTaxGroup: Number(group), taxYear: Number(taxYear), closingBalanceDeclared: Number(balance), additionsDeclared: Number(additions), disposalsDeclared: Number(disposals) })}
      >
        {t("Declare the opening position", "إقرار المركز الافتتاحي")}
      </Button>
    </div>
  );
}

/** One group, one year: the Art. 18 repairs and the two elections. */
function YearDeclarationDialog({ group, taxYear, name, existing, row, busy, t, onClose, onSubmit }: {
  group: number; taxYear: number; name: string;
  existing: IncomeTaxPoolDeclaration | null; row: IncomeTaxPoolGroupYear | null;
  busy: boolean; t: (en: string, ar: string) => string; onClose: () => void; onSubmit: (b: Record<string, unknown>) => void;
}) {
  const [repairs, setRepairs] = useState(existing?.repairsDeclared == null ? "" : String(existing.repairsDeclared));
  const [small, setSmall] = useState(existing?.electSmallBalanceWriteOff ?? false);
  const [closed, setClosed] = useState(existing?.electGroupClosedWriteOff ?? false);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent data-testid="declaration-dialog">
        <DialogHeader>
          <DialogTitle>{t(`Group ${group} — tax year ${taxYear}`, `المجموعة ${group} — السنة الضريبية ${taxYear}`)}</DialogTitle>
          <DialogDescription>{name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs">{t("Art. 18 repairs and improvements for this group, this year", "إصلاحات وتحسينات المادة 18 لهذه المجموعة في هذه السنة")}</Label>
            <Input value={repairs} onChange={(e) => setRepairs(e.target.value)} placeholder={t("not declared", "غير مُقرّ")} data-testid="declare-repairs" dir="ltr" />
            <p className="text-[11px] text-muted-foreground mt-1">
              {t("Deductible up to 4 % of the group's balance; the excess is added to the pool (Art. 18(b)–(c)). The platform cannot attribute repair expense to an Art. 17 group, so this figure is yours — and leaving it blank reads as NOT DECLARED, which is not the same as zero.",
                 "يُحسم حتى 4% من رصيد المجموعة، ويُضاف الفائض إلى الوعاء (المادة 18(ب)–(ج)). ولا تستطيع المنصة نسبة مصروف الإصلاح إلى مجموعة المادة 17، فهذا الرقم منك — وتركه فارغًا يُقرأ «غير مُقرّ»، وهو غير الصفر.")}
            </p>
          </div>
          {row && (
            <div className="space-y-2">
              <p className="text-xs font-medium">{t("Elections — the Law says MAY, so nothing is taken unless you take it", "الخيارات — يقول النظام «يجوز»، فلا يُؤخذ شيء ما لم تأخذه")}</p>
              <label className={`flex items-start gap-2 text-xs ${row.elections.smallBalance.available ? "" : "opacity-50"}`}>
                <Checkbox checked={small} disabled={!row.elections.smallBalance.available} onCheckedChange={(v) => setSmall(v === true)} data-testid="declare-elect-small" />
                <span>{t(`Art. 17(h) — the balance after this year's deduction is below SAR 1,000, so it may be deducted in full (${fmtNum(row.elections.smallBalance.amount)}).`,
                         `المادة 17(ح) — الرصيد بعد حسم هذه السنة أقل من 1,000 ريال، فيجوز حسمه بالكامل (${fmtNum(row.elections.smallBalance.amount)}).`)}</span>
              </label>
              <label className={`flex items-start gap-2 text-xs ${row.elections.groupClosed.available ? "" : "opacity-50"}`}>
                <Checkbox checked={closed} disabled={!row.elections.groupClosed.available} onCheckedChange={(v) => setClosed(v === true)} data-testid="declare-elect-closed" />
                <span>{t(`Art. 17(i) — every asset of this group has been disposed of, so the remaining balance may be deducted (${fmtNum(row.elections.groupClosed.amount)}).`,
                         `المادة 17(ط) — استُبعدت جميع أصول هذه المجموعة، فيجوز حسم الرصيد المتبقي (${fmtNum(row.elections.groupClosed.amount)}).`)}</span>
              </label>
            </div>
          )}
          <Button
            disabled={busy}
            data-testid="declare-submit"
            onClick={() => onSubmit({
              incomeTaxGroup: group,
              taxYear,
              repairsDeclared: repairs.trim() === "" ? null : Number(repairs),
              electSmallBalanceWriteOff: small,
              electGroupClosedWriteOff: closed,
              // an existing anchor for this year keeps its figures
              ...(existing?.closingBalanceDeclared != null
                ? { closingBalanceDeclared: existing.closingBalanceDeclared, additionsDeclared: existing.additionsDeclared, disposalsDeclared: existing.disposalsDeclared }
                : {}),
            })}
          >
            {t("Record", "تسجيل")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
