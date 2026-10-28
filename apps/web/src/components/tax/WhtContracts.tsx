/**
 * 🔴 Phase 18 G4c-1 — WHT owner decision 15 (2026-10-27): WHO BEARS THE TAX is
 * a per-contract setting the user CONFIRMS.
 *
 *  - Tax-inclusive: no gross-up — the tax is withheld from the amount paid.
 *  - Net of tax: the company bears the WHT — the supplier receives the full
 *    amount; the base is grossed up (amount ÷ (1 − rate)) and the tax is the
 *    company's expense, not deductible for income tax (Law Art. 13(e)).
 *
 * A non-resident supplier's contract only. Append-only: a changed setting is a
 * new contract, so a payment's record never moves. The pay forms name the
 * contract; the server decides (`decideWithholding`), never this screen.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListWhtContracts, useCreateWhtContract, getListWhtContractsQueryKey, useListVendors } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";

type T = (en: string, ar: string) => string;
export const taxBearingLabel = (b: string, t: T) =>
  b === "net_of_tax"
    ? t("Net of tax — the company bears the WHT (grossed up)", "صافٍ من الضريبة — تتحمّل المنشأة ضريبة الاستقطاع (بالتغطية)")
    : t("Tax-inclusive — the tax is withheld from the payment", "شامل الضريبة — تُستقطع الضريبة من الدفعة");

export function WhtContracts() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const contracts = useListWhtContracts();
  const vendors = useListVendors({ limit: 200 });
  const nonResident = (vendors.data?.items ?? []).filter((v) => v.residency === "non_resident");
  const vendorName = (id: number) => (vendors.data?.items ?? []).find((v) => v.id === id)?.name ?? `#${id}`;
  const [f, setF] = useState({ vendorId: "", reference: "", taxBearing: "", confirmed: false, note: "" });
  const create = useCreateWhtContract({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListWhtContractsQueryKey() });
        setF({ vendorId: f.vendorId, reference: "", taxBearing: "", confirmed: false, note: "" });
        toast({ title: t("Contract recorded", "سُجّل العقد") });
      },
      onError: (e) => toast({ title: t("Not recorded", "لم يُسجَّل"), description: e instanceof Error ? e.message : String(e), variant: "destructive" }),
    },
  });

  return (
    <div className="space-y-3 rounded border border-border p-3 text-sm" data-testid="wht-contracts">
      <p className="font-medium">{t("Contracts with non-resident suppliers — who bears the withholding tax", "العقود مع الموردين غير المقيمين — من يتحمّل ضريبة الاستقطاع")}</p>
      <p className="text-xs text-muted-foreground">
        {t("Under a NET-OF-TAX contract the supplier receives the full amount and the company bears the tax: it is computed on the grossed-up amount (amount ÷ (1 − rate)), is the company's expense, and is not deductible for income tax (Income Tax Law Art. 13(e)). A tax-inclusive contract, or a payment that names none, withholds the tax from the payment. A contract's setting never changes — record a new contract instead.",
           "في العقد الصافي من الضريبة يستلم المورد كامل المبلغ وتتحمّل المنشأة الضريبة: تُحتسب على المبلغ بعد التغطية (المبلغ ÷ (1 − النسبة))، وهي مصروف على المنشأة، ولا تُحسم لأغراض ضريبة الدخل (نظام ضريبة الدخل المادة 13(هـ)). أما العقد الشامل للضريبة، أو الدفعة التي لا تذكر عقدًا، فتُستقطع الضريبة من الدفعة. ولا يتغير إعداد العقد — سجّل عقدًا جديدًا بدلًا من ذلك.")}
      </p>
      <ul className="space-y-1 text-xs">
        {(contracts.data ?? []).map((c) => (
          <li key={c.id} className="rounded border border-border/60 p-2" data-testid={`wht-contract-${c.id}`}>
            <span className="font-medium">{c.reference}</span> · {vendorName(c.vendorId)} · <span data-testid={`wht-contract-bearing-${c.id}`}>{taxBearingLabel(c.taxBearing, t)}</span>
            {c.note ? <span className="text-muted-foreground"> · {c.note}</span> : null}
          </li>
        ))}
        {contracts.data && contracts.data.length === 0 && <li className="text-muted-foreground">{t("No contract recorded yet.", "لا توجد عقود مسجّلة بعد.")}</li>}
      </ul>

      <div className="grid gap-2 sm:grid-cols-2" data-testid="wht-contract-form">
        <div>
          <Label className="text-xs">{t("Non-resident supplier", "المورد غير المقيم")}</Label>
          <Select value={f.vendorId || "unset"} onValueChange={(v) => setF({ ...f, vendorId: v === "unset" ? "" : v })}>
            <SelectTrigger data-testid="wht-contract-vendor"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="unset">{t("— Choose —", "— اختر —")}</SelectItem>
              {nonResident.map((v) => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">{t("Contract reference", "مرجع العقد")}</Label>
          <Input value={f.reference} maxLength={200} onChange={(e) => setF({ ...f, reference: e.target.value })} data-testid="wht-contract-reference" />
        </div>
        <div className="sm:col-span-2 flex flex-col gap-1" role="radiogroup" aria-label={t("Who bears the tax", "من يتحمّل الضريبة")}>
          {(["tax_inclusive", "net_of_tax"] as const).map((b) => (
            <label key={b} className="flex items-center gap-2 text-xs">
              <input type="radio" name="wht-contract-bearing" className="accent-primary" checked={f.taxBearing === b}
                onChange={() => setF({ ...f, taxBearing: b, confirmed: false })} data-testid={`wht-contract-bearing-${b}`} />
              {taxBearingLabel(b, t)}
            </label>
          ))}
        </div>
        {f.taxBearing && (
          <label className="sm:col-span-2 flex items-start gap-2 text-xs rounded bg-secondary/30 p-2">
            <input type="checkbox" className="accent-primary mt-0.5" checked={f.confirmed} onChange={(e) => setF({ ...f, confirmed: e.target.checked })} data-testid="wht-contract-confirm" />
            <span>
              {f.taxBearing === "net_of_tax"
                ? t("I confirm that under this contract the company bears the withholding tax: the supplier receives the full amount, the tax is computed on the grossed-up amount and is the company's expense, not deductible for income tax.",
                    "أؤكد أن المنشأة تتحمّل ضريبة الاستقطاع بموجب هذا العقد: يستلم المورد كامل المبلغ، وتُحتسب الضريبة على المبلغ بعد التغطية، وهي مصروف على المنشأة لا يُحسم لأغراض ضريبة الدخل.")
                : t("I confirm that under this contract the tax is withheld from the amount paid: the supplier receives the amount less the tax.",
                    "أؤكد أن الضريبة تُستقطع من المبلغ المدفوع بموجب هذا العقد: يستلم المورد المبلغ ناقصًا الضريبة.")}
            </span>
          </label>
        )}
        <div className="sm:col-span-2">
          <Label className="text-xs">{t("Note (optional)", "ملاحظة (اختياري)")}</Label>
          <Input value={f.note} maxLength={2000} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </div>
        <Button size="sm" data-testid="wht-contract-submit"
          disabled={create.isPending || !f.vendorId || !f.reference.trim() || !f.taxBearing || !f.confirmed}
          onClick={() => create.mutate({ data: { vendorId: Number(f.vendorId), reference: f.reference.trim(), taxBearing: f.taxBearing as "tax_inclusive" | "net_of_tax", confirmed: true, ...(f.note.trim() ? { note: f.note.trim() } : {}) } })}>
          {t("Record the contract", "تسجيل العقد")}
        </Button>
      </div>
    </div>
  );
}
