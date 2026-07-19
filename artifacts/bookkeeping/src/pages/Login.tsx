import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info } from "lucide-react";

type Tab = "login" | "register" | "forgot";

export default function Login() {
  const { login } = useAuth();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<Tab>("login");

  // Login state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Register state
  const [regName, setRegName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirm, setRegConfirm] = useState("");
  const [regError, setRegError] = useState("");
  const [regLoading, setRegLoading] = useState(false);

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const API = `${BASE}/api`;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err: any) {
      setError(err.message ?? "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegError("");
    if (regPassword !== regConfirm) { setRegError("Passwords do not match."); return; }
    if (regPassword.length < 8) { setRegError("Password must be at least 8 characters."); return; }
    setRegLoading(true);
    try {
      const res = await fetch(`${API}/auth/register`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: regEmail, name: regName, password: regPassword, role: "admin" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Registration failed");
      await login(regEmail, regPassword);
      navigate("/");
    } catch (err: any) {
      setRegError(err.message ?? "Registration failed");
    } finally {
      setRegLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        {/* Brand */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 mb-3">
            <span className="text-2xl font-bold text-primary">ك</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground">KSA Ledger</h1>
          <p className="text-sm text-muted-foreground">ERP · Accounting</p>
        </div>

        {/* ── Sign In ── */}
        {tab === "login" && (
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle>Sign in</CardTitle>
              <CardDescription>Enter your credentials to access the system</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleLogin} className="space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email" type="email" autoComplete="email"
                    value={email} onChange={e => setEmail(e.target.value)}
                    required placeholder="admin@company.sa"
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password">Password</Label>
                    <button
                      type="button"
                      onClick={() => setTab("forgot")}
                      className="text-xs text-muted-foreground hover:text-primary transition-colors"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <Input
                    id="password" type="password" autoComplete="current-password"
                    value={password} onChange={e => setPassword(e.target.value)}
                    required placeholder="••••••••"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "Signing in…" : "Sign in"}
                </Button>
              </form>
              <p className="mt-4 text-center text-sm text-muted-foreground">
                No account yet?{" "}
                <button onClick={() => setTab("register")} className="text-primary hover:underline">
                  Create account
                </button>
              </p>
            </CardContent>
          </Card>
        )}

        {/* ── Create Account ── */}
        {tab === "register" && (
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle>Create account</CardTitle>
              <CardDescription>
                The first account created becomes the system admin.
                Additional accounts must be created by an admin from User Management.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleRegister} className="space-y-4">
                {regError && (
                  <Alert variant="destructive">
                    <AlertDescription>{regError}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="reg-name">Full name</Label>
                  <Input
                    id="reg-name" autoComplete="name"
                    value={regName} onChange={e => setRegName(e.target.value)}
                    required placeholder="Ahmed Al-Rashidi"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-email">Email</Label>
                  <Input
                    id="reg-email" type="email" autoComplete="email"
                    value={regEmail} onChange={e => setRegEmail(e.target.value)}
                    required placeholder="admin@company.sa"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-password">Password</Label>
                  <Input
                    id="reg-password" type="password" autoComplete="new-password"
                    value={regPassword} onChange={e => setRegPassword(e.target.value)}
                    required placeholder="Min 8 characters" minLength={8}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-confirm">Confirm password</Label>
                  <Input
                    id="reg-confirm" type="password" autoComplete="new-password"
                    value={regConfirm} onChange={e => setRegConfirm(e.target.value)}
                    required placeholder="Repeat password"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={regLoading}>
                  {regLoading ? "Creating…" : "Create account"}
                </Button>
              </form>
              <p className="mt-4 text-center text-sm text-muted-foreground">
                Already have an account?{" "}
                <button onClick={() => setTab("login")} className="text-primary hover:underline">
                  Sign in
                </button>
              </p>
            </CardContent>
          </Card>
        )}

        {/* ── Forgot Password ── */}
        {tab === "forgot" && (
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle>Forgot your password?</CardTitle>
              <CardDescription>How to recover access to your account</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-3 rounded-lg border border-border bg-muted/30 p-4">
                <Info className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <div className="text-sm text-muted-foreground space-y-2">
                  <p className="font-medium text-foreground">Contact your system administrator</p>
                  <p>
                    KSA Ledger does not send password reset emails. Your administrator can
                    reset your password directly from <strong>Settings → User Management</strong>.
                  </p>
                  <p>
                    If you <em>are</em> the administrator, sign in with your current password or
                    use the <strong>Change Password</strong> option after logging in.
                  </p>
                </div>
              </div>
              <Button variant="outline" className="w-full" onClick={() => setTab("login")}>
                ← Back to sign in
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
