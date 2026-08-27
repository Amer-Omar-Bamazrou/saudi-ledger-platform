import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Languages } from "lucide-react";

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
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-4 py-8">
        <div className="text-center mb-6 relative">
          <button
            onClick={() => setLang(lang === "en" ? "ar" : "en")}
            className="absolute top-0 end-0 flex items-center gap-1 text-xs font-bold px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
          >
            <Languages className="w-3 h-3" />
            {lang === "en" ? "ع" : "EN"}
          </button>
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 mb-3">
            <span className="text-2xl font-bold text-primary">ك</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground">KSA Ledger</h1>
          <p className="text-sm text-muted-foreground">{t("Create your organization account", "أنشئ حساب مؤسستك")}</p>
        </div>

        <Card className="border-border/50">
          <CardHeader>
            <CardTitle>{t("Sign up", "إنشاء حساب")}</CardTitle>
            <CardDescription>
              {t(
                "Register your business. Your account is reviewed by our team (usually within 24–48 hours) before it is activated.",
                "سجّل نشاطك التجاري. تتم مراجعة حسابك من قبل فريقنا (عادة خلال 24-48 ساعة) قبل تفعيله.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              {error && (
                <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="organizationName">{t("Organization name *", "اسم المؤسسة *")}</Label>
                <Input id="organizationName" value={form.organizationName} onChange={set("organizationName")} required placeholder="Acme Trading" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="companyName">{t("Company legal name", "الاسم القانوني للشركة")}</Label>
                <Input id="companyName" value={form.companyName} onChange={set("companyName")} placeholder={t("Defaults to the organization name", "يُستخدم اسم المؤسسة افتراضياً")} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="crNumber">{t("CR number *", "رقم السجل التجاري *")}</Label>
                  <Input id="crNumber" value={form.crNumber} onChange={set("crNumber")} required inputMode="numeric" placeholder="1010101010" />
                  <p className="text-[11px] text-muted-foreground">{t("10 digits", "10 أرقام")}</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vatNumber">{t("VAT number", "الرقم الضريبي")}</Label>
                  <Input id="vatNumber" value={form.vatNumber} onChange={set("vatNumber")} inputMode="numeric" placeholder="300000000000003" />
                  <p className="text-[11px] text-muted-foreground">{t("15 digits, if registered", "15 رقماً، إن وُجد")}</p>
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
