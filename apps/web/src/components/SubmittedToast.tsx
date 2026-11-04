import { Link } from "wouter";

/**
 * What the screen says after a document is submitted: where approval happens, with a link (Phase 18 final round, walk
 * finding 17; register §11.138). The toast renders outside the app's router, so the link carries the app's base itself.
 */
export function submittedToast(t: (en: string, ar: string) => string) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return {
    title: t("Submitted for approval", "قُدّم للاعتماد"),
    description: (
      <span data-testid="submitted-where-next">
        {t("An approver approves it on the ", "يعتمده المعتمد من صفحة ")}
        <Link href={`${base}/approvals`} className="underline font-medium" data-testid="submitted-approvals-link">
          {t("Approvals", "الاعتمادات")}
        </Link>
        {t(" page.", ".")}
      </span>
    ),
  };
}
