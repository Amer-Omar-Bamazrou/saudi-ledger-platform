import { useLanguage } from "@/contexts/LanguageContext";

export default function NotFound() {
  // The 2026-09-14 Arabic re-sweep's one wholly-untranslated page: even a 404
  // speaks both languages — an Arabic-first user lost on a bad URL should not
  // ALSO be lost in English.
  const { t } = useLanguage();
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center">
        <p className="text-[13px] font-medium tabular-nums text-primary">404</p>
        <h1 className="mt-2 text-[26px] leading-tight font-semibold text-foreground">{t("This page does not exist.", "هذه الصفحة غير موجودة.")}</h1>
      </div>
    </div>
  );
}
