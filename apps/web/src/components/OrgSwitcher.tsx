import { useEffect, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch } from "@/lib/api";

/**
 * Minimal organization switcher (intentionally unstyled — the UI is temporary).
 * Lists the current user's organization memberships and switches the active one.
 * After switching it reloads the page so every query refetches under the new
 * tenant context resolved by the server.
 */
interface OrgMembership {
  organizationId: string;
  name: string;
  slug: string;
  role: string;
}

export function OrgSwitcher() {
  const { t } = useLanguage();
  const [orgs, setOrgs] = useState<OrgMembership[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<{ activeOrgId: string | null; organizations: OrgMembership[] }>("/orgs")
      .then((data) => {
        setOrgs(data.organizations);
        setActiveOrgId(data.activeOrgId);
      })
      .catch(() => {
        /* non-fatal: the switcher just stays hidden */
      });
  }, []);

  // Nothing to switch between — don't render.
  if (orgs.length <= 1) return null;

  const onChange = async (organizationId: string) => {
    if (organizationId === activeOrgId) return;
    setBusy(true);
    try {
      await apiFetch("/orgs/switch", {
        method: "POST",
        body: JSON.stringify({ organizationId }),
      });
      // Reload so all cached queries refetch under the new active organization.
      window.location.reload();
    } catch {
      setBusy(false);
    }
  };

  return (
    <select
      aria-label={t("Active organization", "المنشأة النشطة")}
      className="w-full h-8 text-xs rounded-md px-2 bg-sidebar-foreground/10 border border-sidebar-foreground/20 text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring [&>option]:bg-popover [&>option]:text-popover-foreground"
      value={activeOrgId ?? ""}
      disabled={busy}
      onChange={(e) => onChange(e.target.value)}
    >
      {orgs.map((o) => (
        <option key={o.organizationId} value={o.organizationId}>
          {o.name} ({o.role})
        </option>
      ))}
    </select>
  );
}
