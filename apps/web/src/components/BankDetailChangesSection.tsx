/**
 * 🔴 Phase 18 R-6 — DR-23's dual control (register §11.98): Company settings →
 * the bank-detail changes waiting for a second admin.
 *
 * In an organisation with two or more admins, a change of a supplier's IBAN,
 * of a bank account's IBAN, or of the account printed on invoices is held
 * until an admin who did not ask for it approves it. This lists the SERVER's
 * requests as they come (newest first) and offers the decision, which the
 * route allows admins only:
 *  - another admin: Approve or Reject;
 *  - an admin who asked: told another admin approves it, and may withdraw it;
 *  - anyone else: told an admin decides.
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

export function BankDetailChangesSection() {
  const { t, lang } = useLanguage();
  const { user, isOrgAdmin } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const list = useListBankDetailChanges();

  const refusal = (e: unknown): string => {
    const code = e instanceof ApiError ? (e.data as { code?: string } | null)?.code : undefined;
    switch (code) {
      case "second_admin_required":
        return t(
          "You asked for this change, so another admin approves it. You can withdraw it.",
          "أنت من طلب هذا التغيير، لذا يوافق عليه مسؤول آخر. ويمكنك سحبه.",
        );
      case "bank_detail_change_stale":
        return t(
          "The bank details changed after this request was made. Reject it and ask again from the details as they are now.",
          "تغيّرت البيانات البنكية بعد تقديم هذا الطلب. ارفضه ثم اطلب التغيير من جديد على البيانات الحالية.",
        );
      case "bank_detail_change_decided":
        return t("This request was already decided. A decision is final.", "سبق البتّ في هذا الطلب، والقرار نهائي.");
      default:
        return e instanceof Error ? e.message : String(e);
    }
  };

  const decide = useDecideBankDetailChange({
    mutation: {
      onSuccess: (r) => {
        qc.invalidateQueries({ queryKey: getListBankDetailChangesQueryKey() });
        qc.invalidateQueries({ queryKey: ["bank-accounts"] });
        qc.invalidateQueries({ queryKey: ["vendors"] });
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
      : k === "bank_account_iban"
        ? t("Bank account IBAN", "آيبان الحساب البنكي")
        : t("Account printed on invoices", "الحساب المطبوع على الفواتير");
  const statusLabel = (s: BankDetailChange["status"]) =>
    s === "pending"
      ? t("Waiting for a second admin", "بانتظار موافقة مسؤول ثانٍ")
      : s === "approved"
        ? t("Approved", "تمت الموافقة")
        : t("Rejected", "مرفوض");
  const iban = (v: string | null) => v ?? t("none", "لا يوجد");

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
            "With two or more admins, a change of a supplier's IBAN, of a bank account's IBAN, or of the account printed on invoices waits here until an admin who did not ask for it approves it.",
            "عند وجود مسؤولَين أو أكثر، ينتظر هنا أي تغيير على آيبان مورد أو آيبان حساب بنكي أو على الحساب المطبوع على الفواتير، حتى يوافق عليه مسؤول غير الذي طلبه.",
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
                    {statusLabel(c.status)}
                  </span>
                </div>
                <p className="font-mono text-xs break-all" dir="ltr">
                  {iban(c.ibanBefore)} → {iban(c.ibanAfter)}
                </p>
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
                    {isOrgAdmin && !mine && (
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
                    {isOrgAdmin && (
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
                      {mine && isOrgAdmin
                        ? t("You asked for this change: another admin approves it.", "أنت من طلب هذا التغيير: يوافق عليه مسؤول آخر.")
                        : !isOrgAdmin
                          ? t("An admin approves or rejects this change.", "يوافق مسؤول النظام على هذا التغيير أو يرفضه.")
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
