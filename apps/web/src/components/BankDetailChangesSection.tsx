/**
 * 🔴 Company settings → the held bank-detail changes.
 *
 *  - 19B S3 (v4 §6.3): a supplier's or an employee's IBAN — the first and every
 *    later one — is ALWAYS held until an accountant or admin who did not ask for
 *    it approves it; when the person who entered it is the only member who could
 *    ever approve it, it applied at once and is listed as such, with the reason.
 *  - Phase 18 R-6 (DR-23): a company bank account's IBAN, or the account printed
 *    on invoices, is held where two or more admins exist, for an admin who did
 *    not ask for it.
 * This lists the SERVER's requests as they come (newest first) and offers the
 * decision to whoever may make it: another approver Approves or Rejects; the
 * one who asked is told someone else approves it, and may withdraw it; anyone
 * else is told who decides. An IBAN the reader may not see is marked withheld.
 * A refusal is explained in the reader's language, keyed on its CODE.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  useListBankDetailChanges,
  useDecideBankDetailChange,
  getListBankDetailChangesQueryKey,
  type BankDetailChange,
} from "@workspace/api-client-react";
import { fmtDate } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { refusalOf } from "@/lib/openingVatRefusals";
import { ibanChangeText } from "@/lib/walkLabels";
import { Withheld } from "@/components/Withheld";

/** 19B S3: the kinds S3's rule governs — decided by an accountant or admin; the rest by an admin (DR-23). */
const isParty = (k: BankDetailChange["kind"]) => k === "vendor_iban" || k === "employee_iban";

export function BankDetailChangesSection() {
  const { t, lang } = useLanguage();
  const { user, isOrgAdmin } = useAuth();
  // 19B S3: who may decide which kind — an accountant or admin a supplier's or employee's IBAN; an admin the company's own.
  const canDecide = (k: BankDetailChange["kind"]) => (isParty(k) ? isOrgAdmin || user?.organizationRole === "accountant" : isOrgAdmin);
  const { toast } = useToast();
  const qc = useQueryClient();
  const list = useListBankDetailChanges();

  const refusal = (e: unknown): string => {
    const code = e instanceof ApiError ? (e.data as { code?: string } | null)?.code : undefined;
    switch (code) {
      case "second_admin_required":
        return t(
          "You asked for this change, so someone else who can approve it approves it. You can withdraw it.",
          "أنت من طلب هذا التغيير، لذا يعتمده شخص آخر ممن يحق لهم اعتماده. ويمكنك سحبه.",
        );
      case "bank_detail_change_admin_only":
        return t("A change of the company's own bank details is decided by an admin.", "يبتّ مسؤول النظام في تغيير البيانات البنكية للشركة نفسها.");
      case "bank_detail_change_stale":
        return t(
          "The bank details changed after this request was made. Reject it and ask again from the details as they are now.",
          "تغيّرت البيانات البنكية بعد تقديم هذا الطلب. ارفضه ثم اطلب التغيير من جديد على البيانات الحالية.",
        );
      case "bank_detail_change_decided":
        return t("This request was already decided. A decision is final.", "سبق البتّ في هذا الطلب، والقرار نهائي.");
      default:
        // 🔴 Walk W2: the server's sentence in the reader's language (A25), never "HTTP 409 Conflict: …" in English
        return refusalOf(e).words;
    }
  };

  const decide = useDecideBankDetailChange({
    mutation: {
      onSuccess: (r) => {
        qc.invalidateQueries({ queryKey: getListBankDetailChangesQueryKey() });
        qc.invalidateQueries({ queryKey: ["bank-accounts"] });
        qc.invalidateQueries({ queryKey: ["vendors"] });
        qc.invalidateQueries({ queryKey: ["employees"] });
        toast({
          title:
            r.status === "approved"
              ? t("Change approved and applied", "تمت الموافقة على التغيير وتطبيقه")
              : t("Change rejected", "تم رفض التغيير"),
        });
      },
      onError: (e) => toast({ title: t("Not decided", "لم يُبتّ فيه"), description: refusal(e), variant: "destructive" }),
    },
  });

  const kindLabel = (k: BankDetailChange["kind"]) =>
    k === "vendor_iban"
      ? t("Supplier IBAN", "آيبان المورد")
      : k === "employee_iban"
        ? t("Employee IBAN", "آيبان الموظف")
        : k === "bank_account_iban"
        ? t("Bank account IBAN", "آيبان الحساب البنكي")
        : t("Account printed on invoices", "الحساب المطبوع على الفواتير");
  const statusLabel = (c: BankDetailChange) =>
    c.status === "pending"
      ? isParty(c.kind)
        ? t("Waiting for an accountant or admin", "بانتظار اعتماد محاسب أو مسؤول")
        : t("Waiting for a second admin", "بانتظار موافقة مسؤول ثانٍ")
      : c.status === "approved"
        ? t("Approved", "تمت الموافقة")
        : c.status === "applied_without_second_approver"
          ? t("Applied without a second approver", "طُبِّق دون معتمِد ثانٍ")
          : t("Rejected", "مرفوض");


  const items = list.data?.items ?? [];
  // 🔴 An empty block does not print its emptiness (CLAUDE.md §3): a company with one admin never holds a change,
  // so the section appears only once there is a request to show.
  if (items.length === 0) return null;
  return (
    <Card className="border-border bg-card" data-testid="bank-detail-changes">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("Bank-detail changes", "تغييرات البيانات البنكية")}</CardTitle>
        <CardDescription>
          {t(
            "A supplier's or an employee's IBAN waits here until an accountant or admin who did not ask for it approves it. With two or more admins, a change of a company bank account's IBAN, or of the account printed on invoices, waits for an admin who did not ask for it.",
            "ينتظر هنا آيبان المورد أو الموظف حتى يعتمده محاسب أو مسؤول لم يطلبه. وعند وجود مسؤولَين أو أكثر، ينتظر أي تغيير على آيبان حساب بنكي للشركة أو على الحساب المطبوع على الفواتير حتى يوافق عليه مسؤول لم يطلبه.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="divide-y divide-border">
          {items.map((c) => {
            const mine = user?.id === c.requestedBy;
            return (
              <li key={c.id} className="py-2 space-y-1" data-testid={`bank-detail-change-${c.id}`} data-status={c.status}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">
                    {kindLabel(c.kind)}
                    {c.subjectName ? ` — ${c.subjectName}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground" data-testid={`bank-detail-change-status-${c.id}`}>
                    {statusLabel(c)}
                  </span>
                </div>
                <p className="font-mono text-xs break-all" dir="ltr">
                  {c.ibanBefore === undefined && c.ibanAfter === undefined
                    ? <Withheld cls="bank_account" testId={`bank-detail-change-iban-withheld-${c.id}`} />
                    : ibanChangeText(c.ibanBefore ?? null, c.ibanAfter ?? null, t)}
                </p>
                {c.status === "applied_without_second_approver" && (
                  <p className="text-[11px] text-attention" data-testid={`bank-detail-change-fallback-${c.id}`}>
                    {t("No other member holds a role that can approve bank details.", "لا يملك أي عضو آخر دوراً يتيح اعتماد البيانات البنكية.")}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {t("Asked by", "طلبه")} {c.requestedByName ?? `#${c.requestedBy}`} · {fmtDate(c.requestedAt, lang)}
                  {c.decidedBy != null && (
                    <>
                      {" "}
                      · {t("decided by", "بتّ فيه")} {c.decidedByName ?? `#${c.decidedBy}`}
                    </>
                  )}
                </p>
                {c.status === "pending" && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {canDecide(c.kind) && !mine && (
                      <Button
                        type="button"
                        size="sm"
                        data-testid={`bank-detail-approve-${c.id}`}
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ id: c.id, data: { decision: "approve" } })}
                      >
                        {t("Approve", "موافقة")}
                      </Button>
                    )}
                    {canDecide(c.kind) && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid={`bank-detail-reject-${c.id}`}
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ id: c.id, data: { decision: "reject" } })}
                      >
                        {mine ? t("Withdraw", "سحب الطلب") : t("Reject", "رفض")}
                      </Button>
                    )}
                    <span className="text-[11px] text-muted-foreground">
                      {mine && canDecide(c.kind)
                        ? isParty(c.kind)
                          ? t("You asked for this change: another accountant or admin approves it.", "أنت من طلب هذا التغيير: يعتمده محاسب أو مسؤول آخر.")
                          : t("You asked for this change: another admin approves it.", "أنت من طلب هذا التغيير: يوافق عليه مسؤول آخر.") // DR-23, unchanged
                        : !canDecide(c.kind)
                          ? isParty(c.kind)
                            ? t("An accountant or admin approves or rejects this change.", "يعتمد محاسب أو مسؤول هذا التغيير أو يرفضه.")
                            : t("An admin approves or rejects this change.", "يوافق مسؤول النظام على هذا التغيير أو يرفضه.")
                          : null}
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
