import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

export type OrganizationRole = "admin" | "accountant" | "bookkeeper" | "viewer";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  /**
   * 🔴 THE VESTIGIAL GLOBAL ROLE. Never gate anything on this — a self-signup
   * org owner is a global "viewer" and an admin of their own organization, so
   * a screen gated on it locks out the person who created the tenant
   * (the M11.5.1 lesson). Kept only for the identity chip in the shell.
   * Use `organizationRole` below.
   */
  role: "admin" | "accountant" | "viewer";
  isActive: boolean;
  /** The active organization, resolved server-side (M18.4.1). */
  organizationId: string | null;
  /** The caller's role IN that organization — the one that means something. */
  organizationRole: OrganizationRole | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  /**
   * Is the caller an admin of the ACTIVE organization?
   *
   * ⚠️ FOR RENDERING ONLY. The server authorizes every route independently
   * (`requirePermission`, admin-of-THIS-org); this decides whether a control is
   * shown, never whether it works. A stale `false` hides a button the server
   * would have allowed; a stale `true` shows one the server refuses with a 403
   * the page must still handle.
   */
  isOrgAdmin: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API = `${BASE}/api`;

async function apiCall(path: string, init?: RequestInit) {
  // Auth is carried by the httpOnly session cookie only (credentials: "include").
  return fetch(`${API}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    ...init,
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchMe = async () => {
    try {
      const res = await apiCall("/auth/me");
      if (res.ok) {
        setUser(await res.json());
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchMe(); }, []);

  const login = async (email: string, password: string) => {
    const res = await apiCall("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Login failed");

    setUser(data.user);
  };

  const logout = async () => {
    await apiCall("/auth/logout", { method: "POST" });
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        // Derived in ONE place. Every page that needed this previously matched
        // the active org against the /orgs list itself, which is how the rule
        // ended up written more than once (M18.4.1).
        isOrgAdmin: user?.organizationRole === "admin",
        login,
        logout,
        refetch: fetchMe,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
