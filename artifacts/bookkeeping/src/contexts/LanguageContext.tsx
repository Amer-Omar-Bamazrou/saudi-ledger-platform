/**
 * LanguageContext.tsx
 *
 * Provides an EN/AR language toggle used throughout the app to:
 *   - Switch UI labels between English and Arabic
 *   - Pick the correct bilingual name field (name vs nameAr) from API data
 *   - Set the document dir and lang attributes for correct RTL rendering
 *
 * Persisted in localStorage as "ksa_lang" so the preference survives refresh.
 *
 * Usage:
 *   const { lang, setLang, t, n } = useLanguage();
 *   t("Vendors", "الموردون")          → picks correct UI label
 *   n(vendor.name, vendor.nameAr)     → picks correct data name
 */
import { createContext, useContext, useState, useEffect } from "react";

export type Lang = "en" | "ar";

interface LanguageContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Pick a UI string: t("English text", "نص عربي") */
  t: (en: string, ar: string) => string;
  /**
   * Pick the right name from a bilingual record.
   *   n(row.name, row.nameAr)
   * Falls back gracefully: if the active-language value is missing or is
   * the placeholder sentinel, returns the other language instead.
   */
  n: (en: string, ar?: string | null) => string;
  /** True when active language is Arabic */
  isAr: boolean;
}

const SENTINEL = "(not yet translated)";

const LanguageContext = createContext<LanguageContextValue>({
  lang: "en",
  setLang: () => {},
  t: (en) => en,
  n: (en) => en,
  isAr: false,
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(
    () => (localStorage.getItem("ksa_lang") as Lang | null) ?? "en"
  );

  function applyLang(l: Lang) {
    document.documentElement.dir  = l === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = l;
  }

  // Apply on mount and whenever lang changes
  useEffect(() => { applyLang(lang); }, [lang]);

  function setLang(l: Lang) {
    setLangState(l);
    localStorage.setItem("ksa_lang", l);
    applyLang(l);
  }

  function t(en: string, ar: string): string {
    return lang === "ar" ? ar : en;
  }

  function n(en: string, ar?: string | null): string {
    if (lang === "ar") {
      const arClean = ar?.trim();
      if (arClean && arClean !== SENTINEL) return arClean;
      return en || "";           // graceful fallback to English
    }
    return en || ar?.trim() || "";
  }

  return (
    <LanguageContext.Provider value={{ lang, setLang, t, n, isAr: lang === "ar" }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
