import { useLanguage } from "@/contexts/LanguageContext";

export default function NotFound() {
  // The 2026-09-14 Arabic re-sweep's one wholly-untranslated page: even a 404
  // speaks both languages — an Arabic-first user lost on a bad URL should not
  // ALSO be lost in English.
  const { t } = useLanguage();
  return (
    <div className="flex items-center justify-center h-[80vh]">
      <div className="text-center space-y-4">
        <h1 className="text-6xl font-mono text-primary font-bold">404</h1>
        <p className="text-xl text-muted-foreground">{t("This page does not exist.", "هذه الصفحة غير موجودة.")}</p>
      </div>
    </div>
  );
}
