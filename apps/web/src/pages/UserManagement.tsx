import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, KeyRound, ShieldCheck, Eye, BookUser } from "lucide-react";

interface User { id: number; email: string; name: string; role: string; isActive: boolean; createdAt: string; }

const ROLE_COLOR: Record<string, string> = {
  admin: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  accountant: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  viewer: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};
const ROLE_ICON: Record<string, React.ElementType> = {
  admin: ShieldCheck, accountant: BookUser, viewer: Eye,
};

const emptyNewUser = { name: "", email: "", password: "", role: "viewer" as string };

export default function UserManagement() {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [newUser, setNewUser] = useState(emptyNewUser);
  const [newPw, setNewPw] = useState("");
  const [createError, setCreateError] = useState("");
  const [resetError, setResetError] = useState("");

  const { data: users = [], isLoading } = useQuery<User[]>({
    queryKey: ["users"],
    queryFn: () => apiFetch("/auth/users"),
  });

  const createMut = useMutation({
    mutationFn: (body: typeof emptyNewUser) =>
      apiFetch("/auth/register", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setCreateOpen(false);
      setNewUser(emptyNewUser);
      setCreateError("");
      toast({ title: t("User created", "تم إنشاء المستخدم") });
    },
    onError: (e: Error) => setCreateError(e.message),
  });

  const patchMut = useMutation({
    mutationFn: ({ id, updates }: { id: number; updates: any }) =>
      apiFetch(`/auth/users/${id}`, { method: "PATCH", body: JSON.stringify(updates) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      toast({ title: t("User updated", "تم تحديث المستخدم") });
    },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const resetMut = useMutation({
    mutationFn: ({ id, newPassword }: { id: number; newPassword: string }) =>
      apiFetch(`/auth/users/${id}/reset-password`, { method: "POST", body: JSON.stringify({ newPassword }) }),
    onSuccess: () => {
      setResetTarget(null);
      setNewPw("");
      setResetError("");
      toast({ title: t("Password reset successfully", "تمت إعادة تعيين كلمة المرور بنجاح") });
    },
    onError: (e: Error) => setResetError(e.message),
  });

  if (me?.role !== "admin") {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground text-sm">{t("Admin access required.", "مطلوب صلاحية المسؤول.")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("User Management", "إدارة المستخدمين")}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t("Create accounts, assign roles, reset passwords", "إنشاء الحسابات، تعيين الأدوار، إعادة تعيين كلمات المرور")}
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={o => { setCreateOpen(o); setCreateError(""); }}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="w-4 h-4" /> {t("Add User", "إضافة مستخدم")}</Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>{t("Create new user", "إنشاء مستخدم جديد")}</DialogTitle></DialogHeader>
            <div className="space-y-3 mt-2">
              {createError && (
                <Alert variant="destructive"><AlertDescription>{createError}</AlertDescription></Alert>
              )}
              <div>
                <Label className="text-xs text-muted-foreground">{t("Full name *", "الاسم الكامل *")}</Label>
                <Input value={newUser.name} onChange={e => setNewUser(p => ({ ...p, name: e.target.value }))}
                  className="mt-1 h-8 text-sm" placeholder="Ahmed Al-Rashidi" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t("Email *", "البريد الإلكتروني *")}</Label>
                <Input type="email" value={newUser.email} onChange={e => setNewUser(p => ({ ...p, email: e.target.value }))}
                  className="mt-1 h-8 text-sm" placeholder="user@company.sa" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t("Temporary password *", "كلمة مرور مؤقتة *")}</Label>
                <Input type="password" value={newUser.password} onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))}
                  className="mt-1 h-8 text-sm" placeholder={t("Min 8 characters", "8 أحرف على الأقل")} minLength={8} />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t("Role *", "الدور *")}</Label>
                <select
                  className="w-full mt-1 h-8 text-sm rounded-md border border-input bg-background px-3 py-1"
                  value={newUser.role}
                  onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))}
                >
                  <option value="viewer">{t("Viewer — read-only access", "مشاهد — وصول للقراءة فقط")}</option>
                  <option value="accountant">{t("Accountant — can create/edit records", "محاسب — يمكنه إنشاء/تعديل السجلات")}</option>
                  <option value="admin">{t("Admin — full access including user management", "مسؤول — وصول كامل بما في ذلك إدارة المستخدمين")}</option>
                </select>
              </div>
              <Button
                className="w-full mt-2"
                onClick={() => createMut.mutate(newUser)}
                disabled={!newUser.name || !newUser.email || !newUser.password || createMut.isPending}
              >
                {createMut.isPending ? t("Creating…", "جارٍ الإنشاء…") : t("Create user", "إنشاء مستخدم")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {(["admin", "accountant", "viewer"] as const).map(role => {
          const Icon = ROLE_ICON[role];
          const count = users.filter(u => u.role === role).length;
          return (
            <Card key={role} className="border-border bg-card">
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
                    <Icon className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold font-mono text-foreground">{count}</p>
                    <p className="text-xs text-muted-foreground capitalize">{role}s</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* User list */}
      {isLoading ? (
        <p className="text-muted-foreground text-sm p-4">{t("Loading users…", "جارٍ تحميل المستخدمين…")}</p>
      ) : (
        <Card className="border-border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("All users", "جميع المستخدمين")}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {users.map(u => {
                const Icon = ROLE_ICON[u.role] ?? Eye;
                const isMe = u.id === me?.id;
                return (
                  <div key={u.id} className="flex items-center gap-4 px-6 py-3">
                    {/* Avatar */}
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <span className="text-xs font-bold text-primary">{u.name.charAt(0).toUpperCase()}</span>
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground truncate">{u.name}</span>
                        {isMe && <span className="text-xs text-muted-foreground">({t("you", "أنت")})</span>}
                        {!u.isActive && <Badge variant="outline" className="text-xs text-red-400 border-red-400/30">{t("Inactive", "غير نشط")}</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                    </div>

                    {/* Role badge */}
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${ROLE_COLOR[u.role] ?? ROLE_COLOR.viewer}`}>
                      {u.role.toUpperCase()}
                    </span>

                    {/* Role change */}
                    <select
                      className="h-7 text-xs rounded border border-input bg-background px-2"
                      value={u.role}
                      onChange={e => patchMut.mutate({ id: u.id, updates: { role: e.target.value } })}
                      disabled={isMe}
                      title={isMe ? t("Cannot change your own role", "لا يمكنك تغيير دورك") : t("Change role", "تغيير الدور")}
                    >
                      <option value="viewer">{t("Viewer", "مشاهد")}</option>
                      <option value="accountant">{t("Accountant", "محاسب")}</option>
                      <option value="admin">{t("Admin", "مسؤول")}</option>
                    </select>

                    {/* Active toggle */}
                    {!isMe && (
                      <button
                        onClick={() => patchMut.mutate({ id: u.id, updates: { isActive: !u.isActive } })}
                        className={`text-xs px-2 py-1 rounded border transition-colors ${u.isActive ? "border-border text-muted-foreground hover:border-red-400/40 hover:text-red-400" : "border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"}`}
                      >
                        {u.isActive ? t("Deactivate", "تعطيل") : t("Activate", "تفعيل")}
                      </button>
                    )}

                    {/* Reset password */}
                    <button
                      onClick={() => { setResetTarget(u); setNewPw(""); setResetError(""); }}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                      title={t("Reset password", "إعادة تعيين كلمة المرور")}
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Reset password dialog */}
      <Dialog open={!!resetTarget} onOpenChange={o => { if (!o) { setResetTarget(null); setNewPw(""); setResetError(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("Reset password", "إعادة تعيين كلمة المرور")} — {resetTarget?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            {resetError && <Alert variant="destructive"><AlertDescription>{resetError}</AlertDescription></Alert>}
            <p className="text-xs text-muted-foreground">
              {t(
                "Set a new temporary password for this user. They can change it later from Settings → Change Password.",
                "عيّن كلمة مرور مؤقتة جديدة لهذا المستخدم. يمكنه تغييرها لاحقاً من الإعدادات ← تغيير كلمة المرور."
              )}
            </p>
            <div>
              <Label className="text-xs text-muted-foreground">{t("New password *", "كلمة المرور الجديدة *")}</Label>
              <Input
                type="password"
                value={newPw}
                onChange={e => setNewPw(e.target.value)}
                className="mt-1 h-8 text-sm"
                placeholder={t("Min 8 characters", "8 أحرف على الأقل")}
                minLength={8}
              />
            </div>
            <Button
              className="w-full"
              onClick={() => resetTarget && resetMut.mutate({ id: resetTarget.id, newPassword: newPw })}
              disabled={newPw.length < 8 || resetMut.isPending}
            >
              {resetMut.isPending ? t("Resetting…", "جارٍ الإعادة…") : t("Reset password", "إعادة تعيين كلمة المرور")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
