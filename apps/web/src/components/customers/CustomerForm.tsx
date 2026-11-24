/**
 * 🔴 ONE form for creating and EDITING a customer (owner, 2026-11-24) — with the structured Saudi national address and
 * the national ID, which no form offered before: a standard tax invoice to a Saudi business buyer needs its street,
 * building number, postal code, city and district (BR-KSA-63, BR-KSA-67; the server refuses the invoice's approval
 * without them — `buyer_address_incomplete`), and an education or healthcare invoice needs the national ID (BR-KSA-49).
 *
 * Role-aware, from the server's own answer (`GET /customers/field-access`, the one class table and the one matrix; D2,
 * S2b): a field the role may not write is not offered; one it may write but not read — the national ID for a bookkeeper
 * — starts empty and is sent only when typed, never read back. An edit sends ONLY what changed, so a withheld value is
 * never sent back as blank. The server is the boundary; this form is not.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateCustomerInput, Customer, FieldAccess, UpdateCustomerInput } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";

const TEXT = ["name", "nameAr", "taxNumber", "crNumber", "nationalId", "phone", "email", "buildingNumber", "street", "district", "city", "postalCode", "additionalNumber", "country", "address", "paymentTermsDays", "creditLimit", "notes"] as const;
type Field = (typeof TEXT)[number];
type Form = Record<Field, string>;

const blankForm = (): Form => ({
  name: "", nameAr: "", taxNumber: "", crNumber: "", nationalId: "", phone: "", email: "", buildingNumber: "", street: "", district: "",
  city: "", postalCode: "", additionalNumber: "", country: "SA", address: "", paymentTermsDays: "30", creditLimit: "", notes: "",
});

/** A field the role may not read starts EMPTY (the key is absent from the record the server served). */
function formOf(c: Customer, access: FieldAccess | undefined): Form {
  const r = c as unknown as Record<string, unknown>;
  const readable = (f: string) => (access?.fields[f]?.read ?? "read") === "read";
  const out = blankForm();
  for (const f of TEXT) out[f] = readable(f) && r[f] != null ? String(r[f]) : f === "country" ? "SA" : "";
  return out;
}

/** The address a standard tax invoice to this buyer needs, as the server checks it (buyerAddress.ts) — for the hint only. */
export function standardInvoiceAddressGaps(f: Pick<Form, "taxNumber" | "country" | "street" | "buildingNumber" | "postalCode" | "city" | "district" | "additionalNumber">): string[] {
  if (f.taxNumber.trim() === "") return [];
  const saudi = (f.country.trim().toUpperCase() || "SA") === "SA";
  if (!saudi) return (["street", "city"] as const).filter((k) => f[k].trim() === "");
  const gaps: string[] = [];
  if (f.street.trim() === "") gaps.push("street");
  if (f.buildingNumber.trim() === "") gaps.push("buildingNumber");
  if (!/^\d{5}$/.test(f.postalCode.trim())) gaps.push("postalCode");
  if (f.city.trim() === "") gaps.push("city");
  if (f.district.trim() === "") gaps.push("district");
  if (f.additionalNumber.trim() !== "" && !/^\d{4}$/.test(f.additionalNumber.trim())) gaps.push("additionalNumber");
  return gaps;
}

export function CustomerForm({ mode, customer, access, open, onOpenChange }: {
  mode: "create" | "edit"; customer?: Customer; access: FieldAccess | undefined; open: boolean; onOpenChange: (o: boolean) => void;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const initial = useMemo(() => (mode === "edit" && customer ? formOf(customer, access) : blankForm()), [mode, customer, access]);
  const [form, setForm] = useState<Form>(initial);
  useEffect(() => { if (open) setForm(initial); }, [open, initial]);
  const set = (k: Field) => (v: string) => setForm((p) => ({ ...p, [k]: v }));

  // a create offers what the role may write; until the answer arrives, the fields every writer holds
  const can = (f: Field) => access ? access.fields[f]?.write === true : !["nationalId"].includes(f);
  const read = (f: Field) => access?.fields[f]?.read ?? "read";
  /** Write-only here: the role may write the field but not read it back (the national ID for a bookkeeper). */
  const blind = (f: Field) => mode === "edit" && can(f) && read(f) !== "read";

  function body(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of TEXT) {
      if (!can(f)) continue;
      const v = form[f].trim();
      const value = f === "creditLimit" ? (v === "" ? null : Number(v)) : v === "" ? null : f === "country" ? v.toUpperCase() : v;
      if (mode === "create") { if (v !== "" || f === "creditLimit") out[f] = value; continue; }
      if (blind(f)) { if (v !== "") out[f] = value; continue; }
      if (v !== initial[f].trim()) out[f] = value;
    }
    if (mode === "create" && out.paymentTermsDays == null) out.paymentTermsDays = "30";
    return out;
  }

  const save = useMutation({
    mutationFn: () =>
      mode === "create"
        ? apiFetch("/customers", { method: "POST", body: JSON.stringify(body() as unknown as CreateCustomerInput) })
        : apiFetch(`/customers/${customer!.id}`, { method: "PATCH", body: JSON.stringify(body() as UpdateCustomerInput) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      if (customer) qc.invalidateQueries({ queryKey: ["customer", customer.id] });
      qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/customers") });
      onOpenChange(false);
      toast({ title: mode === "create" ? t("Customer created", "تم إنشاء العميل") : t("Customer saved", "تم حفظ بيانات العميل") });
    },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const LABELS: Record<Field, [string, string]> = {
    name: ["Name (English) *", "الاسم (بالإنجليزية) *"], nameAr: ["Name (Arabic)", "الاسم (بالعربية)"],
    taxNumber: ["VAT number", "الرقم الضريبي"], crNumber: ["CR number", "رقم السجل التجاري"],
    nationalId: ["National ID (education and healthcare invoices)", "رقم الهوية الوطنية (فواتير التعليم والصحة)"],
    phone: ["Phone", "الهاتف"], email: ["Email", "البريد الإلكتروني"],
    buildingNumber: ["Building number", "رقم المبنى"], street: ["Street", "الشارع"], district: ["District", "الحي"],
    city: ["City", "المدينة"], postalCode: ["Postal code", "الرمز البريدي"], additionalNumber: ["Additional number", "الرقم الإضافي"],
    country: ["Country (2-letter code)", "الدولة (رمز من حرفين)"], address: ["Address line (free text)", "سطر العنوان (نص حر)"],
    paymentTermsDays: ["Payment terms (days)", "مدة السداد (أيام)"], creditLimit: ["Credit limit", "الحد الائتماني"], notes: ["Notes", "ملاحظات"],
  };
  const gaps = standardInvoiceAddressGaps(form);
  const requiredHere = (f: Field) => gaps.includes(f);
  const hint = (f: Field) => (blind(f) ? t("Saved, not shown to your role — type a new one to replace it", "محفوظ ولا يظهر لدورك — اكتب قيمة جديدة لاستبدالها") : undefined);
  const field = (f: Field, opts: { wide?: boolean; ltr?: boolean; inputMode?: "numeric" } = {}) =>
    can(f) && (
      <div key={f} className={opts.wide ? "col-span-2" : ""}>
        <Label className="text-xs text-muted-foreground" htmlFor={`customer-form-${f}`}>
          {t(LABELS[f][0], LABELS[f][1])}{requiredHere(f) && <span className="text-destructive"> *</span>}
        </Label>
        <Input id={`customer-form-${f}`} data-testid={`customer-form-${f}`} value={form[f]} onChange={(e) => set(f)(e.target.value)} placeholder={hint(f)}
          className="mt-1 h-8 text-sm" dir={opts.ltr ? "ltr" : undefined} inputMode={opts.inputMode} aria-invalid={requiredHere(f) || undefined} />
        {hint(f) && <p className="mt-1 text-xs text-muted-foreground">{hint(f)}</p>}
      </div>
    );
  const changes = mode === "edit" ? Object.keys(body()).length : 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="customer-form">
        <DialogHeader><DialogTitle>{mode === "create" ? t("New Customer", "عميل جديد") : t(`Edit ${customer?.name ?? ""}`, `تعديل ${customer?.name ?? ""}`)}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3 mt-2">
          {field("name")}{field("nameAr")}
          {field("taxNumber", { ltr: true, inputMode: "numeric" })}{field("crNumber", { ltr: true, inputMode: "numeric" })}
          {field("nationalId", { ltr: true, inputMode: "numeric" })}{field("phone", { ltr: true })}
          {field("email", { ltr: true, wide: true })}
        </div>
        <h3 className="mt-4 text-sm font-medium">{t("National address", "العنوان الوطني")}</h3>
        {gaps.length > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="customer-form-address-required">
            {t("A tax invoice to a business buyer needs the fields marked *. The invoice cannot be approved without them.",
               "تحتاج الفاتورة الضريبية لمشترٍ منشأة الحقول المعلَّمة بـ *. لا يمكن اعتماد الفاتورة بدونها.")}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 mt-2">
          {field("buildingNumber", { ltr: true, inputMode: "numeric" })}{field("street")}
          {field("district")}{field("city")}
          {field("postalCode", { ltr: true, inputMode: "numeric" })}{field("additionalNumber", { ltr: true, inputMode: "numeric" })}
          {field("country", { ltr: true })}{field("address")}
        </div>
        <div className="grid grid-cols-2 gap-3 mt-4">
          {field("paymentTermsDays", { ltr: true, inputMode: "numeric" })}{field("creditLimit", { ltr: true, inputMode: "numeric" })}
          {field("notes", { wide: true })}
        </div>
        <Button className="w-full mt-4" data-testid="customer-form-save" onClick={() => save.mutate()} disabled={form.name.trim() === "" || save.isPending || changes === 0}>
          {save.isPending ? t("Saving...", "جارٍ الحفظ...") : mode === "create" ? t("Create Customer", "إنشاء عميل") : t("Save", "حفظ")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
