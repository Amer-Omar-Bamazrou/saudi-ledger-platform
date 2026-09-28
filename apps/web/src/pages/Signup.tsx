import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Languages } from "lucide-react";

/**
 * The signed-out shell — the SAME structure as the Login page (teal brand panel
 * on the start side, the form on white), so sign-in, sign-up, an invitation and
 * the verification wait read as one product. Presentation only: each page keeps
 * its own state, handlers and copy and passes them in.
 */
export function AuthShell({
  title,
  description,
  icon,
  wide = false,
  langToggle = false,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  wide?: boolean;
  langToggle?: boolean;
  children: React.ReactNode;
}) {
  const { t, lang, setLang } = useLanguage();
  return (
    <div className="min-h-screen bg-background grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      {/* The spine — the sidebar's teal, as on Login. */}
      <aside className="hidden lg:flex flex-col justify-between bg-sidebar text-sidebar-foreground p-12">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-md bg-sidebar-foreground flex items-center justify-center">
            <span className="font-display text-lg font-bold leading-none text-sidebar -mt-0.5">ك</span>
          </div>
          <span className="font-display font-semibold text-lg">{t("KSA Ledger", "دفتر المملكة")}</span>
        </div>
        <div className="max-w-md">
          <h2 className="text-[28px] leading-[1.25] font-semibold">
            {t("Accounting and compliance for Saudi businesses.", "المحاسبة والامتثال للمنشآت السعودية.")}
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-sidebar-foreground/80">
            {t(
              "Invoices, bills, VAT and the general ledger — in Arabic and English, on the Saudi calendar.",
              "الفواتير والمشتريات وضريبة القيمة المضافة ودفتر الأستاذ العام — بالعربية والإنجليزية، وعلى التقويم السعودي.",
            )}
          </p>
        </div>
        <p className="text-[12px] text-sidebar-foreground/60">© {new Date().getFullYear()} ORGINOO</p>
      </aside>

      <div className="flex items-center justify-center p-4 sm:p-8">
        <div className={cn("w-full space-y-4 py-8", wide ? "max-w-lg" : "max-w-md")}>
          <div className="mb-6 relative">
            {langToggle && (
              <button
                type="button"
                onClick={() => setLang(lang === "en" ? "ar" : "en")}
                className="absolute top-0 end-0 flex items-center gap-1 text-xs font-bold px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground transition-colors"
                title={lang === "en" ? "Switch to Arabic" : "التبديل إلى الإنجليزية"}
              >
                <Languages className="w-3 h-3" />
                {lang === "en" ? "ع" : "EN"}
              </button>
            )}
            <div className="flex items-center gap-2.5 lg:hidden mb-8">
              <div className="w-9 h-9 rounded-md bg-sidebar flex items-center justify-center">
                <span className="font-display text-lg font-bold leading-none text-sidebar-foreground -mt-0.5">ك</span>
              </div>
              <span className="font-display font-semibold text-lg text-foreground">{t("KSA Ledger", "دفتر المملكة")}</span>
            </div>
            {icon && <div className="mb-4">{icon}</div>}
            <h1 className="text-[28px] leading-tight font-semibold text-foreground">{title}</h1>
            {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Public self-service signup (M11.5). Creates the organization + company + admin
 * account in one call; the organization starts in `pending_review`, so on success
 * we send the user straight to the verification status page.
 */
export default function Signup() {
  const [, navigate] = useLocation();
  const { t, lang, setLang } = useLanguage();
  const { refetch } = useAuth();

  const [form, setForm] = useState({
    name: "", email: "", password: "",
    organizationName: "", companyName: "", crNumber: "", vatNumber: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await apiFetch("/auth/signup", { method: "POST", body: JSON.stringify(form) });
      await refetch(); // signup logs us in — pick up the session
      navigate("/verification");
    } catch (err: any) {
      setError(err.message ?? "Signup failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      wide
      langToggle
      title={t("Sign up", "إنشاء حساب")}
      description={t("Create your organization account", "أنشئ حساب مؤسستك")}
    >
            <p className="text-sm text-muted-foreground">
              {t(
                // 🔴 No turnaround promise here (2026-09-15): the review SLA is
                // an undecided owner-process question (CLAUDE.md §5, L3). A
                // number nobody has committed to is a claim with a user on
                // the receiving end — the copy says what happens, not when.
                "Register your business. Your account is reviewed by our team before it is activated.",
                "سجّل نشاطك التجاري. تتم مراجعة حسابك من قبل فريقنا قبل تفعيله.",
              )}
            </p>
            <form onSubmit={submit} className="space-y-4">
              {error && (
                <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="organizationName">{t("Organization name *", "اسم المؤسسة *")}</Label>
                <Input id="organizationName" value={form.organizationName} onChange={set("organizationName")} required placeholder={t("Acme Trading", "شركة المثال التجارية")} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="companyName">{t("Company legal name", "الاسم القانوني للشركة")}</Label>
                <Input id="companyName" value={form.companyName} onChange={set("companyName")} placeholder={t("Defaults to the organization name", "يُستخدم اسم المؤسسة افتراضياً")} />
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="crNumber">{t("CR number *", "رقم السجل التجاري *")}</Label>
                  <Input id="crNumber" value={form.crNumber} onChange={set("crNumber")} required inputMode="numeric" placeholder="1010101010" />
                  <p className="text-[12px] text-muted-foreground">{t("10 digits", "10 أرقام")}</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vatNumber">{t("VAT number", "الرقم الضريبي")}</Label>
                  <Input id="vatNumber" value={form.vatNumber} onChange={set("vatNumber")} inputMode="numeric" placeholder="300000000000003" />
                  <p className="text-[12px] text-muted-foreground">{t("15 digits, if registered", "15 رقماً، إن وُجد")}</p>
                </div>
              </div>

              <div className="border-t border-border pt-4 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="name">{t("Your full name *", "اسمك الكامل *")}</Label>
                  <Input id="name" value={form.name} onChange={set("name")} required placeholder="Ahmed Al-Rashidi" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email">{t("Email *", "البريد الإلكتروني *")}</Label>
                  <Input id="email" type="email" autoComplete="email" value={form.email} onChange={set("email")} required placeholder="you@company.sa" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">{t("Password *", "كلمة المرور *")}</Label>
                  <Input id="password" type="password" autoComplete="new-password" value={form.password} onChange={set("password")} required minLength={8} placeholder={t("Min 8 characters", "8 أحرف على الأقل")} />
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? t("Creating account…", "جارٍ إنشاء الحساب…") : t("Create account", "إنشاء الحساب")}
              </Button>

              <p className="text-center text-xs text-muted-foreground">
                {t("Already have an account?", "لديك حساب بالفعل؟")}{" "}
                <Link href="/login" className="text-primary hover:underline">{t("Sign in", "تسجيل الدخول")}</Link>
              </p>
            </form>
    </AuthShell>
  );
}
