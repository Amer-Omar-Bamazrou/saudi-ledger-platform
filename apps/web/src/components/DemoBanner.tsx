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
      // amber, not the status palette's warning step: this is a standing
      // property of the deployment, not a condition that will clear.
      className="w-full bg-amber-100 text-amber-950 border-b border-amber-300 px-4 py-2 text-sm text-center dark:bg-amber-950 dark:text-amber-100 dark:border-amber-800"
      dir={isAr ? "rtl" : "ltr"}
      role="status"
    >
      <span className="font-semibold">{isAr ? "تجريبي" : "DEMO"}</span>
      <span className="mx-2 opacity-50">·</span>
      <span>{message}</span>
    </div>
  );
}
