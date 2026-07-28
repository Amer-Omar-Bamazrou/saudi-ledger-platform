import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useLocation } from "wouter";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Languages, Info } from "lucide-react";

type Tab = "login" | "forgot";

export default function Login() {
  const { login } = useAuth();
  const [, navigate] = useLocation();
  const { t, lang, setLang } = useLanguage();
  const [tab, setTab] = useState<Tab>("login");

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
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        {/* Brand */}
        <div className="text-center mb-6 relative">
          <button
            onClick={() => setLang(lang === "en" ? "ar" : "en")}
            className="absolute top-0 right-0 flex items-center gap-1 text-xs font-bold px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground transition-colors"
            title={lang === "en" ? "Switch to Arabic" : "التبديل إلى الإنجليزية"}
          >
            <Languages className="w-3 h-3" />
            {lang === "en" ? "ع" : "EN"}
          </button>
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 mb-3">
            <span className="text-2xl font-bold text-primary">ك</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground">KSA Ledger</h1>
          <p className="text-sm text-muted-foreground">{t("ERP · Accounting", "نظام ERP · محاسبة")}</p>
        </div>

        {/* ── Sign In ── */}
        {tab === "login" && (
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle>{t("Sign in", "تسجيل الدخول")}</CardTitle>
              <CardDescription>{t("Enter your credentials to access the system", "أدخل بيانات الاعتماد للوصول إلى النظام")}</CardDescription>
            </CardHeader>
            <CardContent>
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
              </form>
            </CardContent>
          </Card>
        )}

        {/* ── Forgot Password ── */}
        {tab === "forgot" && (
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle>{t("Forgot your password?", "نسيت كلمة المرور؟")}</CardTitle>
              <CardDescription>{t("How to recover access to your account", "كيفية استعادة الوصول إلى حسابك")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
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
  );
}
