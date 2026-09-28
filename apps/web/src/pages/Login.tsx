import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useLocation, Link } from "wouter";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Languages, Info } from "lucide-react";
import { useDeployment } from "@/hooks/useDeployment";

type Tab = "login" | "forgot";

export default function Login() {
  const { login } = useAuth();
  const [, navigate] = useLocation();
  const { t, lang, setLang } = useLanguage();
  const [tab, setTab] = useState<Tab>("login");
  const { demoMode } = useDeployment();

  // Login state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err: any) {
      setError(err.message ?? "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      {/* The spine. The same teal as the app's sidebar, so the first screen
          and every screen after it read as one product. */}
      <aside className="hidden lg:flex flex-col justify-between bg-sidebar text-sidebar-foreground p-12">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-md bg-sidebar-foreground flex items-center justify-center">
            <span className="font-display text-lg font-bold leading-none text-sidebar -mt-0.5">ك</span>
          </div>
          <span className="font-display font-semibold text-lg">{t("KSA Ledger", "دفتر المملكة")}</span>
        </div>
        <div className="max-w-md">
          <h2 className="text-[34px] leading-[1.2] font-semibold">
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
      <div className="w-full max-w-md space-y-4">
        {/* Brand */}
        <div className="mb-6 relative">
          <button
            onClick={() => setLang(lang === "en" ? "ar" : "en")}
            className="absolute top-0 end-0 flex items-center gap-1 text-xs font-bold px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground transition-colors"
            title={lang === "en" ? "Switch to Arabic" : "التبديل إلى الإنجليزية"}
          >
            <Languages className="w-3 h-3" />
            {lang === "en" ? "ع" : "EN"}
          </button>
          <div className="flex items-center gap-2.5 lg:hidden mb-8">
            <div className="w-9 h-9 rounded-md bg-sidebar flex items-center justify-center">
              <span className="font-display text-lg font-bold leading-none text-sidebar-foreground -mt-0.5">ك</span>
            </div>
            <span className="font-display font-semibold text-lg text-foreground">{t("KSA Ledger", "دفتر المملكة")}</span>
          </div>
          <h1 className="text-[28px] font-semibold text-foreground">
            {tab === "login" ? t("Sign in", "تسجيل الدخول") : t("Forgot your password?", "نسيت كلمة المرور؟")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {tab === "login"
              ? t("Enter your credentials to access the system", "أدخل بيانات الاعتماد للوصول إلى النظام")
              : t("How to recover access to your account", "كيفية استعادة الوصول إلى حسابك")}
          </p>
        </div>

        {/* ── Sign In ── */}
        {tab === "login" && (
          <Card className="border-0 bg-transparent">
            <CardContent className="p-0 sm:p-0">
              <form onSubmit={handleLogin} className="space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="email">{t("Email", "البريد الإلكتروني")}</Label>
                  <Input
                    id="email" type="email" autoComplete="email"
                    value={email} onChange={e => setEmail(e.target.value)}
                    required placeholder="admin@company.sa"
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password">{t("Password", "كلمة المرور")}</Label>
                    <button
                      type="button"
                      onClick={() => setTab("forgot")}
                      className="text-xs text-muted-foreground hover:text-primary transition-colors"
                    >
                      {t("Forgot password?", "نسيت كلمة المرور؟")}
                    </button>
                  </div>
                  <Input
                    id="password" type="password" autoComplete="current-password"
                    value={password} onChange={e => setPassword(e.target.value)}
                    required placeholder="••••••••"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? t("Signing in…", "جارٍ تسجيل الدخول…") : t("Sign in", "تسجيل الدخول")}
                </Button>
                {/*
                  Hidden on the demo, where the server refuses POST /auth/signup
                  outright (D4). Showing a link to a route that 403s would make a
                  deliberate restriction look like a bug — and this is the first
                  screen the reviewer sees.
                */}
                {!demoMode && (
                  <p className="text-center text-xs text-muted-foreground">
                    {t("New organization?", "مؤسسة جديدة؟")}{" "}
                    <Link href="/signup" className="text-primary hover:underline">
                      {t("Create an account", "إنشاء حساب")}
                    </Link>
                  </p>
                )}
              </form>
            </CardContent>
          </Card>
        )}

        {/* ── Forgot Password ── */}
        {tab === "forgot" && (
          <Card className="border-0 bg-transparent">
            <CardContent className="space-y-4 p-0 sm:p-0">
              <div className="flex gap-3 rounded-lg border border-border bg-muted/30 p-4">
                <Info className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <div className="text-sm text-muted-foreground space-y-2">
                  <p className="font-medium text-foreground">{t("Contact your system administrator", "تواصل مع مسؤول النظام")}</p>
                  <p>
                    {t(
                      "KSA Ledger does not send password reset emails. Your administrator can reset your password directly from",
                      "لا يرسل KSA Ledger رسائل إعادة تعيين كلمة المرور. يمكن لمسؤولك إعادة تعيين كلمتك مباشرةً من"
                    )}{" "}
                    <strong>{t("Settings → User Management", "الإعدادات ← إدارة المستخدمين")}</strong>.
                  </p>
                  <p>
                    {t(
                      "If you are the administrator, sign in with your current password or use the",
                      "إذا كنت أنت المسؤول، سجّل الدخول بكلمة مرورك الحالية أو استخدم"
                    )}{" "}
                    <strong>{t("Change Password", "تغيير كلمة المرور")}</strong>{" "}
                    {t("option after logging in.", "بعد تسجيل الدخول.")}
                  </p>
                </div>
              </div>
              <Button variant="outline" className="w-full" onClick={() => setTab("login")}>
                {t("← Back to sign in", "← العودة إلى تسجيل الدخول")}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
      </div>
    </div>
  );
}
