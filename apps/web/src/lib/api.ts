const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API = `${BASE}/api`;

/**
 * Error carrying the API's structured body. The verification gate (M11.2) returns
 * 403 `{ code: "org_not_verified", status, reason }`; callers/interceptors use
 * `code` to route the user to the verification status page instead of showing a
 * bare "access denied".
 */
import { emitPeriodClosed } from "./periodClosed";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body: any;
  constructor(status: number, body: any) {
    super(body?.error ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}

/** True when this error is the verification gate blocking an unverified org. */
export function isNotVerified(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === "org_not_verified";
}

/**
 * The ONE place that decides what a failed API response means app-wide.
 *
 * Called by BOTH data paths — `apiFetch` (hand-written call sites) and the
 * generated React Query client (`@workspace/api-client-react`, via the
 * `setApiErrorHandler` hook wired in main.tsx). Both must be covered: the
 * dashboard and most business pages use the generated client, so handling the
 * verification gate in only one of them leaves users staring at a broken page.
 */
export function handleApiErrorResponse(status: number, body: any): void {
  if (typeof window === "undefined") return;

  // The org is not verified — send the user to the verification status page.
  if (status === 403 && body?.code === "org_not_verified") {
    if (!window.location.pathname.replace(/\/$/, "").endsWith("/verification")) {
      window.location.href = `${import.meta.env.BASE_URL}verification`;
    }
  }

  // M22 (D3): a write refused because the month's books are closed. ONE
  // handler for every path that can hit a lock — the dialog explains the
  // refusal in plain words and names the two ways forward. 🔴 Keyed on the
  // structured code, never the message text: rewording server copy must not
  // be able to break this.
  if (status === 423 && body?.code === "period_closed") {
    emitPeriodClosed({
      period: String(body.period ?? ""),
      lockedAt: body.lockedAt ? String(body.lockedAt) : null,
    });
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // FormData must NOT get an explicit Content-Type — the browser has to set the
  // multipart boundary itself. Only default to JSON for non-FormData bodies.
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;

  // Auth is carried by the httpOnly session cookie only (credentials: "include").
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    window.location.href = `${import.meta.env.BASE_URL}login`;
    throw new ApiError(401, { error: "Session expired. Please log in." });
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    handleApiErrorResponse(res.status, body);
    throw new ApiError(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// SAR is hardcoded because the API REFUSES any other currency
// (writeGuards.assertSupportedCurrency + DB CHECK 0062). Before that boundary
// existed this formatter labelled a stored USD amount "SAR" — the number real,
// the unit a lie. It is now correct by construction rather than by luck.
export const fmt = new Intl.NumberFormat("en-SA", { style: "currency", currency: "SAR", minimumFractionDigits: 2 });
export const fmtNum = (v: number) => fmt.format(v);
export const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-SA", { day: "2-digit", month: "short", year: "numeric" });
