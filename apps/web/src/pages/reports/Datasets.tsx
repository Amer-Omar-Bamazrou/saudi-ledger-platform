/**
 * 🔴 19B S5 — the four datasets after journal lines, each its own screen (its production caller, v4 §14) over the shared
 * view. Each passes the GENERATED hook for its rows and its export route as a literal path.
 */
import {
  useRunCashMovementsDataset, useRunPurchaseDocumentsDataset, useRunSalesDocumentsDataset, useRunVatLinesDataset,
} from "@workspace/api-client-react";
import { DatasetView } from "@/components/reports/DatasetView";

export function SalesDocumentsDataset() {
  return (
    <DatasetView name="sales_documents" slug="sales-documents" exportPath="/reports/datasets/sales_documents/export"
      title={["Sales documents", "مستندات المبيعات"]}
      subtitle={["Invoices, credit notes and debit notes in the books. Amounts are positive; the sign column gives the direction (a credit note reverses).", "الفواتير والإشعارات الدائنة والمدينة في الدفاتر. المبالغ موجبة، وعمود الإشارة يبيّن الاتجاه (الإشعار الدائن يعكس)."]}
      useRows={(p) => useRunSalesDocumentsDataset(p)} />
  );
}

export function PurchaseDocumentsDataset() {
  return (
    <DatasetView name="purchase_documents" slug="purchase-documents" exportPath="/reports/datasets/purchase_documents/export"
      title={["Purchase documents", "مستندات المشتريات"]}
      subtitle={["Bills and supplier notes in the books, with what each still owes.", "فواتير الموردين وإشعاراتهم في الدفاتر، مع المستحق على كل منها."]}
      useRows={(p) => useRunPurchaseDocumentsDataset(p)} />
  );
}

export function CashMovementsDataset() {
  return (
    <DatasetView name="cash_movements" slug="cash-movements" exportPath="/reports/datasets/cash_movements/export"
      title={["Cash movements", "الحركات النقدية"]}
      subtitle={["The bank's lines in this company. A transfer or a settlement is listed and is in no income, expense or VAT figure.", "سطور كشف البنك في هذه المنشأة. التحويل أو التسوية يظهر هنا ولا يدخل في أي رقم للإيراد أو المصروف أو الضريبة."]}
      useRows={(p) => useRunCashMovementsDataset(p)} />
  );
}

export function VatLinesDataset() {
  return (
    <DatasetView name="vat_lines" slug="vat-lines" exportPath="/reports/datasets/vat_lines/export"
      title={["VAT lines", "سطور ضريبة القيمة المضافة"]}
      subtitle={["Every amount the VAT return adds for this period, with the box it joins. Input VAT appears only where it is claimed.", "كل مبلغ يضيفه الإقرار الضريبي لهذه الفترة مع الخانة التي يدخلها. تظهر ضريبة المدخلات حيث خُصمت فقط."]}
      useRows={(p) => useRunVatLinesDataset(p)} />
  );
}
