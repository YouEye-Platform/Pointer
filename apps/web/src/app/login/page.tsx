"use client";
import { useState } from "react";
import Link from "next/link";
import { api, ApiError, runtimePath } from "@/lib/api";
import { useAuth, type User } from "@/lib/store";
import { AuthAvailabilityGate } from "@/components/AuthAvailabilityGate";

export default function LoginPage() {
  const setAuth = useAuth((s) => s.setAuth);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await api.post<{ token: string; user: User }>("/api/auth/login", { email, password });
      setAuth(res.token, res.user);
      window.location.replace(runtimePath("/dashboard"));
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <AuthAvailabilityGate>
        <form className="card auth-card stack" onSubmit={submit}>
          <div>
            <h1>Sign in</h1>
            <p className="muted">Pointer control surface</p>
          </div>
          <div className="field">
            <label htmlFor="login-email">Email</label>
            <input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <div className="error">{error}</div>}
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <p className="muted" style={{ textAlign: "center" }}>
            No account? <Link href="/register">Create one</Link>
          </p>
        </form>
      </AuthAvailabilityGate>
    </div>
  );
}
