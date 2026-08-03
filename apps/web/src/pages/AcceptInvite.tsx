import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Mail } from "lucide-react";

/**
 * Public accept-invite page (M11.7). Reached from an invite link
 * (`/accept-invite?token=…`). Two paths, decided by the server's preview:
 *   - no account yet → set a name + password (creates the user + membership);
 *   - account exists → sign in first, then reopen the link.
 */
interface Preview {
  organizationName: string;
  email: string;
  role: string;
  expiresAt: string;
  hasAccount: boolean;
}

export default function AcceptInvite() {
  const [, navigate] = useLocation();
  const { t } = useLanguage();
  const { user, refetch } = useAuth();

  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) { setLoadError(t("This link is missing its invitation token.", "هذا الرابط لا يحتوي على رمز الدعوة.")); return; }
    apiFetch<Preview>(`/invitations/${encodeURIComponent(token)}`)
      .then(setPreview)
      .catch((e: Error) => setLoadError(e.message));
  }, [token, t]);

  const accept = async () => {
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        body: JSON.stringify(preview?.hasAccount ? {} : { name, password }),
      });
      await refetch();
      window.location.href = import.meta.env.BASE_URL; // reload into the new org
    } catch (e: any) {
      setError(e.message ?? "Could not accept the invitation");
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md border-border/50">
          <CardHeader><CardTitle>{t("Invitation unavailable", "الدعوة غير متاحة")}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="destructive"><AlertDescription>{loadError}</AlertDescription></Alert>
            <Button variant="outline" className="w-full" onClick={() => navigate("/login")}>
              {t("Go to sign in", "الذهاب لتسجيل الدخول")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!preview) {
    return <div className="min-h-screen bg-background flex items-center justify-center text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</div>;
  }

  // An account exists but this browser isn't signed in as them.
  const mustSignIn = preview.hasAccount && user?.email?.toLowerCase() !== preview.email;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        <div className="text-center mb-4">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 mb-3">
            <Mail className="w-5 h-5 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">{t("You've been invited", "لقد تمت دعوتك")}</h1>
        </div>

        <Card className="border-border/50">
          <CardHeader>
            <CardTitle>{preview.organizationName}</CardTitle>
            <CardDescription>
              {t("Invitation for", "دعوة لـ")} <strong>{preview.email}</strong> —{" "}
              {t("role", "الدور")}: <strong>{preview.role}</strong>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

            {mustSignIn ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "An account already exists for this email. Sign in as that user, then open this link again.",
                    "يوجد حساب بالفعل لهذا البريد. سجّل الدخول بذلك الحساب ثم افتح هذا الرابط مرة أخرى.",
                  )}
                </p>
                <Button className="w-full" onClick={() => navigate("/login")}>
                  {t("Sign in", "تسجيل الدخول")}
                </Button>
              </>
            ) : preview.hasAccount ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t("You're signed in as the invited user. Join the organization to continue.", "أنت مسجل الدخول كالمستخدم المدعو. انضم إلى المنظمة للمتابعة.")}
                </p>
                <Button className="w-full" disabled={busy} onClick={accept}>
                  {busy ? t("Joining…", "جارٍ الانضمام…") : t("Join organization", "الانضمام إلى المنظمة")}
                </Button>
              </>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); accept(); }} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="name">{t("Your full name *", "اسمك الكامل *")}</Label>
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Ahmed Al-Rashidi" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">{t("Choose a password *", "اختر كلمة مرور *")}</Label>
                  <Input id="password" type="password" autoComplete="new-password" minLength={8}
                    value={password} onChange={(e) => setPassword(e.target.value)} required
                    placeholder={t("Min 8 characters", "8 أحرف على الأقل")} />
                </div>
                <Button type="submit" className="w-full" disabled={busy || !name || password.length < 8}>
                  {busy ? t("Creating account…", "جارٍ إنشاء الحساب…") : t("Accept invitation", "قبول الدعوة")}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
