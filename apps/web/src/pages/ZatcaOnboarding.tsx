import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { ShieldCheck, AlertTriangle, CheckCircle2, XCircle, Clock } from "lucide-react";

/**
 * ZATCA Phase 2 onboarding (M12.4).
 *
 * The tenant generates the OTP in their OWN Fatoora portal and pastes it here —
 * we never ask for, see, or store their ERAD credentials. The OTP is used once
 * for a single CSID request and is never persisted.
 */
interface Prerequisite {
  key: string;
  label: string;
  satisfied: boolean;
  hint: string;
}

interface OnboardingStatus {
  environment: "sandbox" | "simulation" | "production";
  prerequisites: Prerequisite[];
  ready: boolean;
  certificate: {
    status: string;
    notAfter: string | null;
    daysUntilExpiry: number | null;
    egsSerialNumber: string | null;
  } | null;
}

interface DocumentResult {
  label: string;
  passed: boolean;
  errors: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
}

interface OnboardResult {
  complianceDocuments: DocumentResult[];
  activated: boolean;
}

/** Renewal needs the tenant's own action, so warn well before expiry. */
function expiryTone(days: number | null): { label: string; className: string } {
  if (days === null) return { label: "unknown", className: "text-muted-foreground" };
  if (days <= 7) return { label: `${days} days left`, className: "text-destructive font-semibold" };
  if (days <= 30) return { label: `${days} days left`, className: "text-destructive" };
  if (days <= 90) return { label: `${days} days left`, className: "text-yellow-600" };
  return { label: `${days} days left`, className: "text-muted-foreground" };
}

export default function ZatcaOnboarding() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [otp, setOtp] = useState("");
  const [result, setResult] = useState<OnboardResult | null>(null);
  const [error, setError] = useState("");

  const { data: status, isLoading } = useQuery<OnboardingStatus>({
    queryKey: ["zatca-onboarding"],
    queryFn: () => apiFetch("/api/zatca/onboarding"),
  });

  const onboard = useMutation({
    mutationFn: (): Promise<OnboardResult> =>
      apiFetch("/api/zatca/onboarding", {
        method: "POST",
        body: JSON.stringify({ otp }),
      }),
    onSuccess: (data) => {
      setResult(data);
      setOtp("");
      setError("");
      qc.invalidateQueries({ queryKey: ["zatca-onboarding"] });
      toast({
        title: data.activated ? "ZATCA onboarding complete" : "Compliance checks failed",
        description: data.activated
          ? "This company can now issue ZATCA-cleared invoices."
          : "No certificate was stored. See the failing documents below.",
        variant: data.activated ? undefined : "destructive",
      });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  if (isLoading) return <div className="p-6">Loading…</div>;
  if (!status) return <div className="p-6">Unable to load onboarding status.</div>;

  const cert = status.certificate;
  const tone = expiryTone(cert?.daysUntilExpiry ?? null);

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">ZATCA e-invoicing (Phase 2)</h1>
        <p className="text-muted-foreground">
          Connect this company to ZATCA so its invoices can be cleared and reported.
        </p>
      </div>

      {status.environment === "sandbox" && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>Sandbox environment.</strong> ZATCA's sandbox accepts <em>any</em> OTP and
            returns a shared test certificate that is not tied to this company. Onboarding here
            verifies the integration only — it does <strong>not</strong> enable real invoicing.
          </AlertDescription>
        </Alert>
      )}

      {/* ── Certificate status ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Certificate
          </CardTitle>
          <CardDescription>The credential that signs this company's invoices.</CardDescription>
        </CardHeader>
        <CardContent>
          {cert ? (
            <div className="space-y-1 text-sm">
              <div>
                Status: <span className="font-medium">{cert.status}</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Expires:{" "}
                <span className="font-medium">
                  {cert.notAfter ? new Date(cert.notAfter).toLocaleDateString() : "unknown"}
                </span>
                <span className={tone.className}>({tone.label})</span>
              </div>
              {cert.egsSerialNumber && (
                <div className="text-muted-foreground">Unit: {cert.egsSerialNumber}</div>
              )}
              {cert.daysUntilExpiry !== null && cert.daysUntilExpiry <= 90 && (
                <Alert className="mt-3">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    ZATCA certificates last 5 years with <strong>no grace period</strong>. When it
                    expires, invoicing stops immediately. Renewal needs a new OTP from your Fatoora
                    portal, so start before the deadline.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No certificate yet — complete the steps below.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Prerequisites ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Before you start</CardTitle>
          <CardDescription>
            ZATCA requires these on every invoice. Set them in{" "}
            <Link href="/company" className="underline">
              Company Settings
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {status.prerequisites.map((p) => (
              <li key={p.key} className="flex items-start gap-2 text-sm">
                {p.satisfied ? (
                  <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-600 shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
                )}
                <span>
                  <span className={p.satisfied ? "" : "font-medium"}>{p.label}</span>
                  {!p.satisfied && (
                    <span className="block text-muted-foreground">{p.hint}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* ── OTP ────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>One-time password</CardTitle>
          <CardDescription>
            Sign in to the ZATCA Fatoora portal, generate an OTP for this solution unit, and paste
            it below. We never see your Fatoora credentials, and the OTP is not stored.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="otp">OTP from Fatoora</Label>
            <Input
              id="otp"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              placeholder="123456"
              autoComplete="off"
              disabled={!status.ready}
            />
          </div>

          {!status.ready && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Complete the missing company details above before onboarding.
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button
            onClick={() => onboard.mutate()}
            disabled={!status.ready || !otp.trim() || onboard.isPending}
          >
            {onboard.isPending ? "Running compliance checks…" : "Onboard with ZATCA"}
          </Button>
        </CardContent>
      </Card>

      {/* ── Compliance results ─────────────────────────────────────────── */}
      {result && (
        <Card>
          <CardHeader>
            <CardTitle>Compliance checks</CardTitle>
            <CardDescription>
              ZATCA validates six documents — standard and simplified invoices, credit notes and
              debit notes. All six must pass before a certificate is issued.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {result.complianceDocuments.map((d) => (
              <div key={d.label} className="text-sm">
                <div className="flex items-center gap-2">
                  {d.passed ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                  <span className="font-medium">{d.label}</span>
                </div>
                {d.errors.map((e) => (
                  <div key={e.code} className="ml-6 text-destructive">
                    {e.code}: {e.message}
                  </div>
                ))}
                {d.warnings.map((w) => (
                  <div key={w.code} className="ml-6 text-yellow-600">
                    {w.code}: {w.message}
                  </div>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
