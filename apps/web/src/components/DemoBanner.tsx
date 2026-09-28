/**
 * The demo banner (D7).
 *
 * 🔴 THE TEXT COMES FROM THE SERVER, IN BOTH LANGUAGES. Nothing here decides
 * whether this is a demo, and nothing here composes the sentence: a banner the
 * frontend authored would keep claiming "demo" on a bundle promoted elsewhere,
 * and — worse — would keep claiming "wiped weekly" after the wipe stopped
 * happening, because the bundle has no way to know. The server reads its own
 * database and reports what has actually been done.
 *
 * Both languages arrive together and this component only PICKS, so the claim is
 * identical whichever language the viewer has selected. A demo notice that is
 * missing (or softer) in Arabic is a notice that does not work for half of the
 * intended audience.
 *
 * Renders nothing at all when `demoMode` is false — which is every ordinary
 * deployment — and nothing while the request is in flight, because a banner
 * that flashes and disappears is worse than one that arrives a beat late.
 */
import { useLanguage } from "@/contexts/LanguageContext";
import { useDeployment } from "@/hooks/useDeployment";

export function DemoBanner() {
  const { lang, isAr } = useLanguage();
  const deployment = useDeployment();

  if (!deployment.demoMode) return null;

  const message = lang === "ar" ? deployment.messageAr : deployment.messageEn;
  if (!message) return null;

  return (
    <div
      // The accent tint, not the status palette's warning step: this is a
      // standing property of the deployment, not a condition that will clear.
      // (Was raw amber; the 2026-09 design pass moved it onto tokens.)
      className="w-full bg-accent text-accent-foreground border-b border-accent-border px-4 py-2 text-[13px] text-center"
      dir={isAr ? "rtl" : "ltr"}
      role="status"
    >
      <span className="me-2 inline-flex items-center rounded bg-background/60 px-1.5 py-0.5 text-[12px] font-semibold">{isAr ? "تجريبي" : "Demo"}</span>
      <span>{message}</span>
    </div>
  );
}
