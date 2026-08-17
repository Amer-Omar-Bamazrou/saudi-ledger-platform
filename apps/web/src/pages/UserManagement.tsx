import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtDate } from "@/lib/api";
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
import { Plus, KeyRound, ShieldCheck, Eye, BookUser, PencilRuler } from "lucide-react";

interface User { id: number; email: string; name: string; role: string; isActive: boolean; createdAt: string; }
interface Member { userId: number; name: string; email: string; role: string; status: string; }
interface Invitation { id: string; email: string; role: string; status: string; expiresAt: string; createdAt: string; }

// The active-org membership role governs access (M10). This page manages THAT
// role (via /orgs/:orgId/members), not the vestigial global users.role.
const MEMBERSHIP_ROLES = ["viewer", "bookkeeper", "accountant", "admin"] as const;

const ROLE_COLOR: Record<string, string> = {
  admin: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  accountant: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  bookkeeper: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  viewer: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};
const ROLE_ICON: Record<string, React.ElementType> = {
  admin: ShieldCheck, accountant: BookUser, bookkeeper: PencilRuler, viewer: Eye,
};

const emptyNewUser = { name: "", email: "", password: "", role: "bookkeeper" as string };

export default function UserManagement() {
  const { user: me, isOrgAdmin } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [newUser, setNewUser] = useState(emptyNewUser);
  const [newPw, setNewPw] = useState("");
  const [createError, setCreateError] = useState("");
  const [resetError, setResetError] = useState("");
  const [invite, setInvite] = useState({ email: "", role: "bookkeeper" });
  const [inviteLink, setInviteLink] = useState("");
  const [inviteError, setInviteError] = useState("");

  // Active org — the org whose memberships we administer here. We also read the
  // caller's MEMBERSHIP role in that org: since M11.5.1 the global `users.role`
  // is no longer a privilege (a self-signup org owner is a global "viewer" but an
  // admin of their own org), so gating this page on the global role would lock
  // out legitimate org admins. The server authorizes off the membership too.
  const { data: orgsData } = useQuery<{
    activeOrgId: string | null;
    organizations: Array<{ organizationId: string; role: string }>;
  }>({
    queryKey: ["orgs"],
    queryFn: () => apiFetch("/orgs"),
  });
  const activeOrgId = orgsData?.activeOrgId ?? null;
  // M18.4.1 — the membership role now comes from `/auth/me` via AuthContext,
  // resolved server-side with the same selector `resolveTenant` uses. This page
  // used to match the active org against the /orgs list itself; that derivation
  // was one of two copies of a rule that disagreed once a session's chosen org
  // was no longer a live membership. (`isOrgAdmin` comes from useAuth above.)

  const { data: users = [], isLoading } = useQuery<User[]>({
    queryKey: ["users"],
    queryFn: () => apiFetch("/auth/users"),
  });

  // Membership roles in the active org (the governing roles).
  const { data: membersData } = useQuery<{ members: Member[] }>({
    queryKey: ["members", activeOrgId],
    queryFn: () => apiFetch(`/orgs/${activeOrgId}/members`),
    enabled: !!activeOrgId,
  });
  const roleByUser = new Map((membersData?.members ?? []).map((m) => [m.userId, m.role]));

  // Assign / change a user's membership role in the active org (upsert).
  const assignMut = useMutation({
    mutationFn: ({ userId, role }: { userId: number; role: string }) =>
      apiFetch(`/orgs/${activeOrgId}/members`, { method: "POST", body: JSON.stringify({ userId, role }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members", activeOrgId] });
      toast({ title: t("Role assigned", "تم تعيين الدور") });
    },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  // Create a user (global identity) THEN give them a membership in the active org
  // with the chosen role — otherwise a created user has no membership and is
  // denied on every business route (the M10.1 provisioning gap).
  const createMut = useMutation({
    mutationFn: async (body: typeof emptyNewUser) => {
      const user = await apiFetch<User>("/auth/register", { method: "POST", body: JSON.stringify(body) });
      if (activeOrgId) {
        await apiFetch(`/orgs/${activeOrgId}/members`, { method: "POST", body: JSON.stringify({ userId: user.id, role: body.role }) });
      }
      return user;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["members", activeOrgId] });
      setCreateOpen(false);
      setNewUser(emptyNewUser);
      setCreateError("");
      toast({ title: t("User created & added to organization", "تم إنشاء المستخدم وإضافته إلى المنظمة") });
    },
    onError: (e: Error) => setCreateError(e.message),
  });

  // Global identity ops (activate/deactivate the account) stay on /auth/users.
  const patchMut = useMutation({
    mutationFn: ({ id, updates }: { id: number; updates: any }) =>
      apiFetch(`/auth/users/${id}`, { method: "PATCH", body: JSON.stringify(updates) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      toast({ title: t("User updated", "تم تحديث المستخدم") });
    },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  // ── Invitations (M11.7) ────────────────────────────────────────────────────
  const { data: invitesData } = useQuery<{ invitations: Invitation[] }>({
    queryKey: ["invitations", activeOrgId],
    queryFn: () => apiFetch(`/orgs/${activeOrgId}/invitations`),
    enabled: !!activeOrgId,
    retry: false,
  });

  const refreshInvites = () => qc.invalidateQueries({ queryKey: ["invitations", activeOrgId] });

  const inviteMut = useMutation({
    mutationFn: (body: { email: string; role: string }) =>
      apiFetch<{ link: string }>(`/orgs/${activeOrgId}/invitations`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (res) => {
      setInviteLink(res.link);
      setInvite({ email: "", role: "bookkeeper" });
      setInviteError("");
      refreshInvites();
    },
    onError: (e: Error) => setInviteError(e.message),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/orgs/${activeOrgId}/invitations/${id}`, { method: "DELETE" }),
    onSuccess: () => { refreshInvites(); toast({ title: t("Invitation revoked", "تم إلغاء الدعوة") }); },
    onError: (e: Error) => setInviteError(e.message),
  });

  const resendMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ link: string }>(`/orgs/${activeOrgId}/invitations/${id}/resend`, { method: "POST" }),
    onSuccess: (res) => { setInviteLink(res.link); refreshInvites(); },
    onError: (e: Error) => setInviteError(e.message),
  });

  const removeMemberMut = useMutation({
    mutationFn: (userId: number) =>
      apiFetch(`/orgs/${activeOrgId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members", activeOrgId] });
      toast({ title: t("Member removed", "تمت إزالة العضو") });
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

  // Wait for the memberships to load before deciding (avoids a flash of "denied").
  if (orgsData && !isOrgAdmin) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground text-sm">
          {t("Organization admin access required.", "مطلوب صلاحية مسؤول المنظمة.")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("User Management", "إدارة المستخدمين")}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t("Create accounts and assign their role in this organization", "إنشاء الحسابات وتعيين دورهم في هذه المنظمة")}
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
                <Label className="text-xs text-muted-foreground">{t("Role in this organization *", "الدور في هذه المنظمة *")}</Label>
                <select
                  className="w-full mt-1 h-8 text-sm rounded-md border border-input bg-background px-3 py-1"
                  value={newUser.role}
                  onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))}
                >
                  <option value="viewer">{t("Viewer — read-only access", "مشاهد — وصول للقراءة فقط")}</option>
                  <option value="bookkeeper">{t("Bookkeeper — enters drafts, cannot approve", "ماسك دفاتر — يُدخل المسودات، لا يعتمد")}</option>
                  <option value="accountant">{t("Accountant — create/edit and approve records", "محاسب — إنشاء/تعديل واعتماد السجلات")}</option>
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

      {/* Stats — by membership role in the active org */}
      <div className="grid grid-cols-4 gap-4">
        {MEMBERSHIP_ROLES.map(role => {
          const Icon = ROLE_ICON[role];
          const count = (membersData?.members ?? []).filter(m => m.role === role).length;
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
                const orgRole = roleByUser.get(u.id) ?? "";
                const Icon = ROLE_ICON[orgRole] ?? Eye;
                const isMe = u.id === me?.id;
                return (
                  <div key={u.id} className="flex items-center gap-4 px-6 py-3">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <span className="text-xs font-bold text-primary">{u.name.charAt(0).toUpperCase()}</span>
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground truncate">{u.name}</span>
                        {isMe && <span className="text-xs text-muted-foreground">({t("you", "أنت")})</span>}
                        {!u.isActive && <Badge variant="outline" className="text-xs text-red-400 border-red-400/30">{t("Inactive", "غير نشط")}</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                    </div>

                    {/* Membership role badge (the governing role) */}
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${ROLE_COLOR[orgRole] ?? "bg-zinc-500/10 text-zinc-500 border-zinc-500/20"}`}>
                      {orgRole ? orgRole.toUpperCase() : t("NO MEMBERSHIP", "بدون عضوية")}
                    </span>

                    {/* Membership role change (upsert in the active org) */}
                    <select
                      className="h-7 text-xs rounded border border-input bg-background px-2"
                      value={orgRole}
                      onChange={e => assignMut.mutate({ userId: u.id, role: e.target.value })}
                      disabled={isMe || !activeOrgId}
                      title={isMe ? t("Cannot change your own role", "لا يمكنك تغيير دورك") : t("Set organization role", "تعيين دور المنظمة")}
                    >
                      <option value="" disabled>{t("Set role…", "تعيين الدور…")}</option>
                      <option value="viewer">{t("Viewer", "مشاهد")}</option>
                      <option value="bookkeeper">{t("Bookkeeper", "ماسك دفاتر")}</option>
                      <option value="accountant">{t("Accountant", "محاسب")}</option>
                      <option value="admin">{t("Admin", "مسؤول")}</option>
                    </select>

                    {!isMe && orgRole && (
                      <button
                        onClick={() => removeMemberMut.mutate(u.id)}
                        className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:border-red-400/40 hover:text-red-400 transition-colors"
                        title={t("Remove from this organization", "إزالة من هذه المنظمة")}
                      >
                        {t("Remove", "إزالة")}
                      </button>
                    )}

                    {!isMe && (
                      <button
                        onClick={() => patchMut.mutate({ id: u.id, updates: { isActive: !u.isActive } })}
                        className={`text-xs px-2 py-1 rounded border transition-colors ${u.isActive ? "border-border text-muted-foreground hover:border-red-400/40 hover:text-red-400" : "border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"}`}
                      >
                        {u.isActive ? t("Deactivate", "تعطيل") : t("Activate", "تفعيل")}
                      </button>
                    )}

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

      {/* ── Invitations (M11.7) ─────────────────────────────────────────── */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("Invitations", "الدعوات")}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {t(
              "Invite a teammate by email. No email is sent yet — copy the link and share it with them.",
              "ادعُ زميلاً عبر البريد. لا يتم إرسال بريد بعد — انسخ الرابط وشاركه معه.",
            )}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {inviteError && <Alert variant="destructive"><AlertDescription>{inviteError}</AlertDescription></Alert>}

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[220px]">
              <Label className="text-xs text-muted-foreground">{t("Email", "البريد الإلكتروني")}</Label>
              <Input
                type="email" className="mt-1 h-8 text-sm" placeholder="teammate@company.sa"
                value={invite.email}
                onChange={e => setInvite(p => ({ ...p, email: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("Role", "الدور")}</Label>
              <select
                className="mt-1 h-8 text-sm rounded-md border border-input bg-background px-2 block"
                value={invite.role}
                onChange={e => setInvite(p => ({ ...p, role: e.target.value }))}
              >
                {MEMBERSHIP_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <Button
              size="sm"
              disabled={!invite.email || inviteMut.isPending || !activeOrgId}
              onClick={() => inviteMut.mutate(invite)}
            >
              {inviteMut.isPending ? t("Inviting…", "جارٍ الدعوة…") : t("Send invitation", "إرسال دعوة")}
            </Button>
          </div>

          {inviteLink && (
            <Alert>
              <AlertDescription className="space-y-2">
                <p className="text-xs font-medium">{t("Share this link with the invitee:", "شارك هذا الرابط مع المدعو:")}</p>
                <div className="flex gap-2">
                  <Input readOnly value={inviteLink} className="h-8 text-xs font-mono" onFocus={e => e.currentTarget.select()} />
                  <Button size="sm" variant="outline" onClick={() => navigator.clipboard?.writeText(inviteLink)}>
                    {t("Copy", "نسخ")}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          <div className="divide-y divide-border">
            {(invitesData?.invitations ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">{t("No invitations yet.", "لا توجد دعوات بعد.")}</p>
            ) : invitesData!.invitations.map(inv => (
              <div key={inv.id} className="flex items-center gap-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{inv.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {inv.role} · {t("expires", "تنتهي")} {fmtDate(inv.expiresAt)}
                  </p>
                </div>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-border text-muted-foreground uppercase">
                  {inv.status}
                </span>
                {inv.status === "pending" && (
                  <>
                    <button onClick={() => resendMut.mutate(inv.id)} className="text-xs text-muted-foreground hover:text-primary">
                      {t("Resend", "إعادة إرسال")}
                    </button>
                    <button onClick={() => revokeMut.mutate(inv.id)} className="text-xs text-muted-foreground hover:text-red-400">
                      {t("Revoke", "إلغاء")}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

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
