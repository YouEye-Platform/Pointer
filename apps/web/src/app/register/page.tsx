"use client";
import { useState } from "react";
import Link from "next/link";
import { api, ApiError, runtimePath } from "@/lib/api";
import { useAuth, type User } from "@/lib/store";
import { AuthAvailabilityGate } from "@/components/AuthAvailabilityGate";

export default function RegisterPage() {
  const setAuth = useAuth((s) => s.setAuth);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await api.post<{ token: string; user: User }>("/api/auth/register", { name, email, password });
      setAuth(res.token, res.user);
      window.location.replace(runtimePath("/dashboard"));
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <AuthAvailabilityGate>
        <form className="card auth-card stack" onSubmit={submit}>
          <div>
            <h1>Create account</h1>
            <p className="muted">The first account becomes the admin.</p>
          </div>
          <div className="field">
            <label htmlFor="register-name">Name</label>
            <input id="register-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label htmlFor="register-email">Email</label>
            <input id="register-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="register-password">Password</label>
            <input id="register-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          </div>
          {error && <div className="error">{error}</div>}
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create account"}
          </button>
          <p className="muted" style={{ textAlign: "center" }}>
            Already have an account? <Link href="/login">Sign in</Link>
          </p>
        </form>
      </AuthAvailabilityGate>
    </div>
  );
}
