const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API = `${BASE}/api`;

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",   // send session cookie with every request
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (res.status === 401) {
    // Redirect to login — avoid circular import by using window location
    window.location.href = `${import.meta.env.BASE_URL}login`;
    return undefined as T;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const fmt = new Intl.NumberFormat("en-SA", { style: "currency", currency: "SAR", minimumFractionDigits: 2 });
export const fmtNum = (v: number) => fmt.format(v);
export const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-SA", { day: "2-digit", month: "short", year: "numeric" });
