import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function ChangePassword() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess(false);
    if (next !== confirm) { setError("New passwords do not match."); return; }
    if (next.length < 8) { setError("Password must be at least 8 characters."); return; }
    setLoading(true);
    try {
      await apiFetch("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      setSuccess(true);
      setCurrent(""); setNext(""); setConfirm("");
    } catch (err: any) {
      setError(err.message ?? "Failed to change password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("Change Password", "تغيير كلمة المرور")}</h1>
        <p className="text-muted-foreground text-sm mt-1">Update the password for {user?.email}</p>
      </div>

      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-base">{t("New password", "كلمة المرور الجديدة")}</CardTitle>
          <CardDescription>You'll remain logged in after changing your password.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            {success && (
              <Alert className="border-emerald-500/30 bg-emerald-500/10">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <AlertDescription className="text-emerald-400">{t("Password changed successfully.", "تم تغيير كلمة المرور بنجاح.")}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="current">{t("Current password", "كلمة المرور الحالية")}</Label>
              <Input
                id="current" type="password" autoComplete="current-password"
                value={current} onChange={e => setCurrent(e.target.value)} required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="next">{t("New password", "كلمة المرور الجديدة")}</Label>
              <Input
                id="next" type="password" autoComplete="new-password"
                value={next} onChange={e => setNext(e.target.value)}
                required minLength={8} placeholder={t("Min 8 characters", "8 أحرف على الأقل")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm">{t("Confirm new password", "تأكيد كلمة المرور الجديدة")}</Label>
              <Input
                id="confirm" type="password" autoComplete="new-password"
                value={confirm} onChange={e => setConfirm(e.target.value)} required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Updating…" : "Change password"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
