import { useEffect, useState } from "react";
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
      aria-label="Active organization"
      className="w-full text-xs border border-border rounded px-1.5 py-1 bg-background text-foreground"
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
