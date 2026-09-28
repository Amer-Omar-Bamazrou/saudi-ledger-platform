import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtDate } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { PageHeader, Panel, StatStrip, Stat } from "@/components/kit";
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
  admin: "bg-attention-surface/20 text-attention border-attention-surface/30",
  accountant: "bg-info-surface/20 text-info border-info-surface/30",
  bookkeeper: "bg-positive-surface/20 text-positive border-positive-surface/30",
  viewer: "bg-muted text-muted-foreground border-border",
};
const ROLE_ICON: Record<string, React.ElementType> = {
  admin: ShieldCheck, accountant: BookUser, bookkeeper: PencilRuler, viewer: Eye,
};

/** One settings group: what it is on the start side, its content on the end side (stacked on a phone). */
function SettingsGroup({ title, description, children }: { title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Panel>
      <div className="grid md:grid-cols-[16rem_1fr] gap-6">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        <div className="min-w-0 space-y-4">{children}</div>
      </div>
    </Panel>
  );
}

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
    <div className="space-y-6 max-w-5xl">
      <PageHeader
        title={t("User Management", "إدارة المستخدمين")}
        description={t("Create accounts and assign their role in this organization", "إنشاء الحسابات وتعيين دورهم في هذه المنظمة")}
        actions={
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
                <Label className="text-[13px] text-muted-foreground">{t("Full name *", "الاسم الكامل *")}</Label>
                <Input value={newUser.name} onChange={e => setNewUser(p => ({ ...p, name: e.target.value }))}
                  className="mt-1" placeholder="Ahmed Al-Rashidi" />
              </div>
              <div>
                <Label className="text-[13px] text-muted-foreground">{t("Email *", "البريد الإلكتروني *")}</Label>
                <Input type="email" value={newUser.email} onChange={e => setNewUser(p => ({ ...p, email: e.target.value }))}
                  className="mt-1" placeholder="user@company.sa" />
              </div>
              <div>
                <Label className="text-[13px] text-muted-foreground">{t("Temporary password *", "كلمة مرور مؤقتة *")}</Label>
                <Input type="password" value={newUser.password} onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))}
                  className="mt-1" placeholder={t("Min 8 characters", "8 أحرف على الأقل")} minLength={8} />
              </div>
              <div>
                <Label className="text-[13px] text-muted-foreground">{t("Role in this organization *", "الدور في هذه المنظمة *")}</Label>
                <select
                  className="w-full mt-1 h-9 text-sm rounded-md border border-input bg-background px-3 py-1"
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
        }
      />

      {/* Stats — by membership role in the active org */}
      <StatStrip cols={4}>
        {MEMBERSHIP_ROLES.map(role => {
          const count = (membersData?.members ?? []).filter(m => m.role === role).length;
          return (
            <Stat
              key={role}
              label={({ viewer: t("Viewers", "المشاهدون"), bookkeeper: t("Bookkeepers", "مدخلو البيانات"), accountant: t("Accountants", "المحاسبون"), admin: t("Admins", "المسؤولون") } as Record<string, string>)[role] ?? role}
              value={count}
            />
          );
        })}
      </StatStrip>

      {/* User list */}
      <SettingsGroup
        title={t("All users", "جميع المستخدمين")}
        description={t(
          "Each person's role in this organization decides what they can do here. Deactivating an account stops the person signing in anywhere.",
          "يحدد دور كل شخص في هذه المنظمة ما يمكنه فعله هنا. تعطيل الحساب يمنع صاحبه من تسجيل الدخول في أي مكان.",
        )}
      >
      {isLoading ? (
        <p className="text-muted-foreground text-sm">{t("Loading users…", "جارٍ تحميل المستخدمين…")}</p>
      ) : (
            <div className="divide-y divide-border rounded-md border border-border">
              {users.map(u => {
                const orgRole = roleByUser.get(u.id) ?? "";
                const Icon = ROLE_ICON[orgRole] ?? Eye;
                const isMe = u.id === me?.id;
                return (
                  <div key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                    <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center shrink-0">
                      <span className="text-xs font-semibold text-accent-foreground">{u.name.charAt(0).toUpperCase()}</span>
                    </div>

                    <div className="flex-1 min-w-[10rem]">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground truncate">{u.name}</span>
                        {isMe && <span className="text-xs text-muted-foreground">({t("you", "أنت")})</span>}
                        {!u.isActive && <Badge variant="outline" className="text-xs text-negative border-negative/30">{t("Inactive", "غير نشط")}</Badge>}
                      </div>
                      <p className="text-[13px] text-muted-foreground truncate">{u.email}</p>
                    </div>

                    {/* Membership role badge (the governing role) */}
                    <span className={`inline-flex items-center gap-1 text-[12px] font-medium px-1.5 py-0.5 rounded border capitalize ${ROLE_COLOR[orgRole] ?? "bg-muted text-muted-foreground border-border"}`}>
                      <Icon className="w-3 h-3" />
                      {orgRole ? (({ viewer: t("Viewer", "مشاهد"), bookkeeper: t("Bookkeeper", "ماسك دفاتر"), accountant: t("Accountant", "محاسب"), admin: t("Admin", "مسؤول") } as Record<string, string>)[orgRole] ?? orgRole) : t("No membership", "بدون عضوية")}
                    </span>

                    <div className="flex items-center gap-1.5">
                    {/* Membership role change (upsert in the active org) */}
                    <select
                      className="h-8 text-[13px] rounded-md border border-input bg-background px-2"
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
                        className="text-xs h-8 px-2 rounded-md border border-border text-muted-foreground hover:border-negative/40 hover:text-negative transition-colors"
                        title={t("Remove from this organization", "إزالة من هذه المنظمة")}
                      >
                        {t("Remove", "إزالة")}
                      </button>
                    )}

                    {!isMe && (
                      <button
                        onClick={() => patchMut.mutate({ id: u.id, updates: { isActive: !u.isActive } })}
                        className={`text-xs h-8 px-2 rounded-md border transition-colors ${u.isActive ? "border-border text-muted-foreground hover:border-negative/40 hover:text-negative" : "border-positive-surface/30 text-positive hover:bg-positive-surface/10"}`}
                      >
                        {u.isActive ? t("Deactivate", "تعطيل") : t("Activate", "تفعيل")}
                      </button>
                    )}

                    <button
                      onClick={() => { setResetTarget(u); setNewPw(""); setResetError(""); }}
                      className="flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:text-primary hover:bg-muted transition-colors"
                      title={t("Reset password", "إعادة تعيين كلمة المرور")}
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                    </button>
                    </div>
                  </div>
                );
              })}
            </div>
      )}
      </SettingsGroup>

      {/* ── Invitations (M11.7) ─────────────────────────────────────────── */}
      <SettingsGroup
        title={t("Invitations", "الدعوات")}
        description={t(
          "Invite a teammate by email. No email is sent yet — copy the link and share it with them.",
          "ادعُ زميلاً عبر البريد. لا يتم إرسال بريد بعد — انسخ الرابط وشاركه معه.",
        )}
      >
          {inviteError && <Alert variant="destructive"><AlertDescription>{inviteError}</AlertDescription></Alert>}

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[220px]">
              <Label className="text-[13px] text-muted-foreground">{t("Email", "البريد الإلكتروني")}</Label>
              <Input
                type="email" className="mt-1" placeholder="teammate@company.sa"
                value={invite.email}
                onChange={e => setInvite(p => ({ ...p, email: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-[13px] text-muted-foreground">{t("Role", "الدور")}</Label>
              <select
                className="mt-1 h-9 text-sm rounded-md border border-input bg-background px-2 block capitalize"
                value={invite.role}
                onChange={e => setInvite(p => ({ ...p, role: e.target.value }))}
              >
                {MEMBERSHIP_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <Button
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
                  <Input readOnly value={inviteLink} className="h-8 text-xs font-mono" dir="ltr" onFocus={e => e.currentTarget.select()} />
                  <Button size="sm" variant="outline" onClick={() => navigator.clipboard?.writeText(inviteLink)}>
                    {t("Copy", "نسخ")}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          <div className="divide-y divide-border border-t border-border">
            {(invitesData?.invitations ?? []).length === 0 ? (
              <p className="text-[13px] text-muted-foreground pt-3">{t("No invitations yet.", "لا توجد دعوات بعد.")}</p>
            ) : invitesData!.invitations.map(inv => (
              <div key={inv.id} className="flex items-center gap-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{inv.email}</p>
                  <p className="text-[12px] text-muted-foreground">
                    <span className="capitalize">{inv.role}</span> · {t("expires", "تنتهي")} {fmtDate(inv.expiresAt)}
                  </p>
                </div>
                <span className="text-[12px] font-medium px-1.5 py-0.5 rounded border border-border text-muted-foreground capitalize">
                  {inv.status}
                </span>
                {inv.status === "pending" && (
                  <>
                    <button onClick={() => resendMut.mutate(inv.id)} className="text-xs text-muted-foreground hover:text-primary">
                      {t("Resend", "إعادة إرسال")}
                    </button>
                    <button onClick={() => revokeMut.mutate(inv.id)} className="text-xs text-muted-foreground hover:text-negative">
                      {t("Revoke", "إلغاء")}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
      </SettingsGroup>

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
              <Label className="text-[13px] text-muted-foreground">{t("New password *", "كلمة المرور الجديدة *")}</Label>
              <Input
                type="password"
                value={newPw}
                onChange={e => setNewPw(e.target.value)}
                className="mt-1"
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
