/**
 * CASH POSITION & BANKING EXCEPTIONS (Phase 12D, 2026-09-23).
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §6.
 *
 * Per bank: the LEDGER balance (the one definition every report uses), the
 * latest statement's closing balance beside the ledger at that statement's
 * date, what is still unreconciled, and how far the bank is reconciled.
 * 🔴 Where no statement states a balance, the comparison reads NOT KNOWN —
 * never a zero that reads as "agrees".
 *
 * Then what needs a person, each with where to go. Every capped list says
 * its true total beside it.
 */
import { Link } from "wouter";
import { fmtNum } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/contexts/LanguageContext";
import { PageHeader, Panel } from "@/components/kit";
import { useGetCashPosition, useGetBankingExceptions } from "@workspace/api-client-react";
import { CONTINUITY } from "@/pages/BankStatements";

/** Rows rendered per list; the note beside each list names the true total. */
const SHOWN = 25;

const Money = ({ v }: { v: number }) => <span className="tabular-nums whitespace-nowrap" dir="ltr">{fmtNum(v)}</span>;

export default function CashPosition() {
  const { t, lang } = useLanguage();
  const { data: cp, isLoading, isError } = useGetCashPosition();
  const { data: x } = useGetBankingExceptions();

  return (
    <div className="space-y-6" data-testid="page-cash-position">
      <PageHeader
        title={t("Cash position & exceptions", "المركز النقدي والاستثناءات")}
        description={t("Each bank's ledger balance — the same figure every report uses — beside what its latest statement says, and what is still waiting to be reconciled.",
             "الرصيد الدفتري لكل بنك — الرقم ذاته في كل التقارير — بجانب ما يقوله آخر كشف، وما ينتظر التسوية.")}
      />

      <Panel flush>
        <div className="overflow-x-auto">
          {isLoading ? <p className="p-5 text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
            : isError || !cp ? <p className="p-5 text-sm text-destructive">{t("Could not load the cash position.", "تعذر تحميل المركز النقدي.")}</p>
            : (
              <table className="w-full text-sm" data-testid="cp-table">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-start px-3">{t("Bank", "البنك")}</th>
                    <th className="text-end px-3">{t("Ledger balance", "الرصيد الدفتري")}</th>
                    <th className="text-start px-3">{t("Latest statement", "آخر كشف")}</th>
                    <th className="text-start px-3">{t("Unreconciled", "غير مسوّى")}</th>
                    <th className="text-start px-3">{t("Reconciled through", "مسوّى حتى")}</th>
                  </tr>
                </thead>
                <tbody>
                  {cp.banks.map((b) => (
                    <tr key={b.bankAccountId} className="border-b border-border/70 hover:bg-muted/40 transition-colors align-top" data-testid={`cp-bank-${b.bankAccountId}`}>
                      <td className="py-3 px-3 min-w-[10rem]"><span className="font-medium">{b.name}</span>{!b.isActive && <Badge variant="outline" className="ms-2 capitalize">{t("inactive", "غير نشط")}</Badge>}<div className="text-[12px] text-muted-foreground">{b.bankName} · {b.currency}</div></td>
                      <td className="py-3 px-3 text-end whitespace-nowrap font-medium" data-testid={`cp-ledger-${b.bankAccountId}`}><Money v={b.ledgerBalance} /></td>
                      <td className="py-3 px-3 min-w-[16rem]" data-testid={`cp-statement-${b.bankAccountId}`}>
                        {b.latestStatement ? (
                          <div className="space-y-0.5">
                            <div>{t("Bank says ", "البنك: ")}<Money v={b.latestStatement.closingBalance} /> <span className="text-muted-foreground" dir="ltr">({b.latestStatement.periodTo})</span></div>
                            <div className="text-[12px] text-muted-foreground">{t("Ledger at that date ", "الدفتر في ذلك التاريخ ")}<Money v={b.latestStatement.ledgerAtThatDate} /> · {t("gap before reconciling items ", "الفرق قبل بنود التسوية ")}<Money v={b.latestStatement.grossDifference} /></div>
                          </div>
                        ) : <span className="text-muted-foreground">{t("No statement states a closing balance — not known", "لا يوجد كشف برصيد ختامي — غير معروف")}</span>}
                      </td>
                      <td className="py-3 px-3">
                        {b.unreconciledLines + b.partialLines === 0
                          ? <span className="text-muted-foreground">{t("none", "لا شيء")}</span>
                          : <Link href="/bank-reconciliation" className="text-primary hover:underline">{t(`${b.unreconciledLines} line(s), ${b.partialLines} partial`, `${b.unreconciledLines} سطر، ${b.partialLines} جزئي`)}</Link>}
                        {(b.outstandingIn > 0 || b.outstandingOut > 0) && (
                          <div className="text-[12px] text-muted-foreground">{t("in ", "وارد ")}<Money v={b.outstandingIn} /> · {t("out ", "صادر ")}<Money v={b.outstandingOut} /></div>
                        )}
                      </td>
                      <td className="py-3 px-3 whitespace-nowrap"><span dir="ltr">{b.reconciledThrough ?? <span className="text-muted-foreground">—</span>}</span></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <td className="py-3 px-3">{t("Total, active SAR banks", "الإجمالي، البنوك النشطة بالريال")}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap" data-testid="cp-total"><Money v={cp.totalLedgerBalance} /></td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            )}
        </div>
      </Panel>

      {x && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="cp-exceptions">
          <Panel title={t("Statement lines waiting", "أسطر كشف بانتظار التسوية")} bodyClassName="text-sm space-y-2">
              <p className="text-muted-foreground" data-testid="cp-lines-total">
                {t(`${x.lines.total} line(s) unreconciled for more than ${x.staleAfterDays} days, or only partly reconciled`, `${x.lines.total} سطر غير مسوّى منذ أكثر من ${x.staleAfterDays} يومًا أو مسوّى جزئيًا`)}
                {x.lines.total > Math.min(SHOWN, x.lines.items.length) && t(` — showing the first ${Math.min(SHOWN, x.lines.items.length)}`, ` — يُعرض أول ${Math.min(SHOWN, x.lines.items.length)}`)}
              </p>
              <ul className="divide-y divide-border">
                {x.lines.items.slice(0, SHOWN).map((i) => (
                  <li key={i.transactionId} className="flex justify-between gap-3 py-2">
                    <Link href="/bank-reconciliation" className="text-primary hover:underline min-w-0 truncate"><span dir="ltr" className="me-2">{i.date}</span>{i.description}</Link>
                    <span className="whitespace-nowrap">{i.kind === "partial" ? <Badge variant="outline" className="me-2">{t("partial", "جزئي")}</Badge> : null}<Money v={i.direction === "in" ? i.amount : -i.amount} /></span>
                  </li>
                ))}
              </ul>
          </Panel>
          <Panel title={t("Transfers", "التحويلات")} bodyClassName="text-sm space-y-2">
              <p data-testid="cp-clearing">
                {x.transferClearing.nets
                  ? t("Transfer clearing nets to zero — every own-account leg has its partner.", "حساب التحويلات الوسيط صفري — لكل طرف تحويل نظيره.")
                  : <>{t("Transfer clearing does not net: ", "حساب التحويلات الوسيط غير صفري: ")}<Money v={x.transferClearing.balance} />{t(" — a leg accepted on one bank has no partner on the other.", " — طرف مقبول في بنك بلا نظير في الآخر.")}</>}
              </p>
              <p className="text-muted-foreground">{t(`${x.transfersMissingLegs.length} recorded transfer(s) older than ${x.staleAfterDays} days without both bank lines reconciled`, `${x.transfersMissingLegs.length} تحويل مسجل أقدم من ${x.staleAfterDays} يومًا دون تسوية طرفيه`)}
                {x.transfersMissingLegs.length > SHOWN && t(` — showing the first ${SHOWN}`, ` — يُعرض أول ${SHOWN}`)}</p>
              <ul className="divide-y divide-border">
                {x.transfersMissingLegs.slice(0, SHOWN).map((tr) => (
                  <li key={tr.transferId} className="flex justify-between gap-3 py-2">
                    <Link href="/bank-transfers" className="text-primary hover:underline"><span dir="ltr" className="me-2">{tr.transferDate}</span>{tr.from} → {tr.to}</Link>
                    <span>{t(`${tr.reconciledLegs} of 2`, `${tr.reconciledLegs} من 2`)} · <Money v={tr.amount} /></span>
                  </li>
                ))}
              </ul>
          </Panel>
          <Panel title={t("Statement continuity", "تسلسل الكشوف")} bodyClassName="text-sm">
              {x.continuity.length === 0
                ? <p className="text-muted-foreground" data-testid="cp-continuity-none">{t("No gaps, overlaps or balances that fail to carry between statements.", "لا فجوات ولا تداخل ولا أرصدة لا تنتقل بين الكشوف.")}</p>
                : <ul className="divide-y divide-border">{x.continuity.map((c) => (
                    <li key={c.statementId} className="py-2"><Link href="/bank-statements" className="text-primary hover:underline"><span dir="ltr">{c.periodFrom} → {c.periodTo}</span></Link> · {CONTINUITY[c.continuity as keyof typeof CONTINUITY] ? t(CONTINUITY[c.continuity as keyof typeof CONTINUITY].en, CONTINUITY[c.continuity as keyof typeof CONTINUITY].ar) : c.continuity}
                      {/* The detail is the server's English sentence — shown in English only, as on the statements register. */}
                      {c.detail && lang !== "ar" ? ` — ${c.detail}` : ""}</li>
                  ))}</ul>}
          </Panel>
          <Panel title={t("Ledger cash no statement answers", "نقد دفتري لا يقابله كشف")} bodyClassName="text-sm space-y-2">
              <p className="text-muted-foreground" data-testid="cp-ledger-total">
                {t(`${x.ledgerLines.total} cash line(s) older than ${x.staleAfterDays} days that no statement line reconciles`, `${x.ledgerLines.total} سطر نقدي أقدم من ${x.staleAfterDays} يومًا لا يسوّيه أي سطر كشف`)}
                {x.ledgerLines.total > Math.min(SHOWN, x.ledgerLines.items.length) && t(` — showing the first ${Math.min(SHOWN, x.ledgerLines.items.length)}`, ` — يُعرض أول ${Math.min(SHOWN, x.ledgerLines.items.length)}`)}
              </p>
              <ul className="divide-y divide-border">
                {x.ledgerLines.items.slice(0, SHOWN).map((l) => (
                  <li key={l.journalLineId} className="flex justify-between gap-3 py-2">
                    <Link href={`/journal-entries?entry=${l.journalEntryId}`} className="text-primary hover:underline"><span dir="ltr" className="me-2">{l.date}</span>{l.entryNumber}</Link>
                    <Money v={l.outstanding} />
                  </li>
                ))}
              </ul>
          </Panel>
        </div>
      )}
    </div>
  );
}
