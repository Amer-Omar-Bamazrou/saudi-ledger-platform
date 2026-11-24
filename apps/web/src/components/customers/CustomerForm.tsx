/**
 * 🔴 ONE form for creating and EDITING a customer (owner, 2026-11-24) — with the structured Saudi national address and
 * the national ID, which no form offered before: a standard tax invoice to a Saudi business buyer needs its street,
 * building number, postal code, city and district (BR-KSA-63, BR-KSA-67; the server refuses the invoice's approval
 * without them — `buyer_address_incomplete`), and an education or healthcare invoice needs the national ID (BR-KSA-49).
 *
 * Role-aware, from the server's own answer (`GET /customers/field-access`, the one class table and the one matrix; D2,
 * S2b): a field the role may not write is not offered; one it may write but not read — the national ID for a bookkeeper
 * — starts empty and is sent only when typed, never read back. The request itself is built by `customerFormBody`
 * (@workspace/shared), the one definition the live ZATCA pass sends too. The server is the boundary; this form is not.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateCustomerInput, Customer, FieldAccess, UpdateCustomerInput } from "@workspace/api-client-react";
import { CUSTOMER_FORM_FIELDS, blankCustomerForm, customerFormBody, standardInvoiceAddressGaps, type CustomerFormField, type CustomerFormValues } from "@workspace/shared";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";

/** A field the role may not read starts EMPTY (the key is absent from the record the server served). */
function formOf(c: Customer, access: FieldAccess | undefined): CustomerFormValues {
  const r = c as unknown as Record<string, unknown>;
  const readable = (f: string) => (access?.fields[f]?.read ?? "read") === "read";
  const out = blankCustomerForm();
  for (const f of CUSTOMER_FORM_FIELDS) out[f] = readable(f) && r[f] != null ? String(r[f]) : f === "country" ? "SA" : "";
  return out;
}

const LABELS: Record<CustomerFormField, [string, string]> = {
  // the established wording (Phase 18 Z5, e2e/phase18-z5-arabic-wording.spec.ts) for every field the old form had
  name: ["Company Name (English) *", "اسم الشركة (بالإنجليزية) *"], nameAr: ["Company Name (Arabic)", "اسم الشركة (بالعربية)"],
  taxNumber: ["VAT Number", "رقم ضريبة القيمة المضافة"], crNumber: ["CR Number", "رقم السجل التجاري"],
  nationalId: ["National ID (education and healthcare invoices)", "رقم الهوية الوطنية (فواتير التعليم والصحة)"],
  phone: ["Phone", "الهاتف"], email: ["Email", "البريد الإلكتروني"],
  buildingNumber: ["Building number", "رقم المبنى"], street: ["Street", "الشارع"], district: ["District", "الحي"],
  city: ["City", "المدينة"], postalCode: ["Postal code (5 digits)", "الرمز البريدي (5 أرقام)"], additionalNumber: ["Additional number (4 digits)", "الرقم الإضافي (4 أرقام)"],
  country: ["Country (2-letter code)", "الدولة (رمز من حرفين)"], address: ["Address", "العنوان"],
  paymentTermsDays: ["Payment Terms (days)", "شروط الدفع (أيام)"], creditLimit: ["Credit Limit (SAR)", "حد الائتمان (ر.س)"], notes: ["Notes", "ملاحظات"],
};

export function CustomerForm({ mode, customer, access, open, onOpenChange }: {
  mode: "create" | "edit"; customer?: Customer; access: FieldAccess | undefined; open: boolean; onOpenChange: (o: boolean) => void;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const initial = useMemo(() => (mode === "edit" && customer ? formOf(customer, access) : blankCustomerForm()), [mode, customer, access]);
  const [form, setForm] = useState<CustomerFormValues>(initial);
  useEffect(() => { if (open) setForm(initial); }, [open, initial]);
  const set = (k: CustomerFormField) => (v: string) => setForm((p) => ({ ...p, [k]: v }));

  // until the server's answer arrives, a create offers what every writer holds (not the national ID)
  const can = (f: CustomerFormField) => (access ? access.fields[f]?.write === true : f !== "nationalId");
  const read = (f: CustomerFormField) => access?.fields[f]?.read ?? "read";
  /** Write-only here: the role may write the field but not read it back (the national ID for a bookkeeper). */
  const blind = (f: CustomerFormField) => mode === "edit" && can(f) && read(f) !== "read";
  const body = () => customerFormBody(mode, form, initial, can, blind);

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

  const gaps = standardInvoiceAddressGaps(form);
  const requiredHere = (f: CustomerFormField) => gaps.includes(f);
  const hint = (f: CustomerFormField) => (blind(f) ? t("Saved, not shown to your role — type a new one to replace it", "محفوظ ولا يظهر لدورك — اكتب قيمة جديدة لاستبدالها") : undefined);
  const field = (f: CustomerFormField, opts: { wide?: boolean; ltr?: boolean; numeric?: boolean } = {}) =>
    can(f) && (
      <div key={f} className={opts.wide ? "col-span-2" : ""}>
        <Label className="text-xs text-muted-foreground" htmlFor={`customer-form-${f}`}>
          {t(LABELS[f][0], LABELS[f][1])}{requiredHere(f) && <span className="text-destructive" data-testid={`customer-form-required-${f}`}> *</span>}
        </Label>
        <Input id={`customer-form-${f}`} data-testid={`customer-form-${f}`} value={form[f]} onChange={(e) => set(f)(e.target.value)} placeholder={hint(f)}
          className="mt-1 h-8 text-sm" dir={opts.ltr ? "ltr" : undefined} inputMode={opts.numeric ? "numeric" : undefined} aria-invalid={requiredHere(f) || undefined} />
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
          {field("taxNumber", { ltr: true, numeric: true })}{field("crNumber", { ltr: true, numeric: true })}
          {field("nationalId", { ltr: true, numeric: true })}{field("phone", { ltr: true })}
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
          {field("buildingNumber", { ltr: true, numeric: true })}{field("street")}
          {field("district")}{field("city")}
          {field("postalCode", { ltr: true, numeric: true })}{field("additionalNumber", { ltr: true, numeric: true })}
          {field("country", { ltr: true })}{field("address")}
        </div>
        <div className="grid grid-cols-2 gap-3 mt-4">
          {field("paymentTermsDays", { ltr: true, numeric: true })}{field("creditLimit", { ltr: true, numeric: true })}
          {field("notes", { wide: true })}
        </div>
        <Button className="w-full mt-4" data-testid="customer-form-save" onClick={() => save.mutate()} disabled={form.name.trim() === "" || save.isPending || changes === 0}>
          {save.isPending ? t("Saving...", "جارٍ الحفظ...") : mode === "create" ? t("Create Customer", "إنشاء عميل") : t("Save", "حفظ")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
