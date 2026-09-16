"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/store";
import { ThemeSelector } from "@/components/ThemeSelector";
import { runtimePath } from "@/lib/api";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/models", label: "Models" },
  { href: "/providers", label: "Providers" },
  { href: "/instances", label: "Instances" },
  { href: "/keys", label: "API Keys" },
  { href: "/groups", label: "Model Groups" },
  { href: "/chat", label: "Proxy Test" },
  { href: "/test-model", label: "Test Model" },
  { href: "/usage", label: "Usage" },
  { href: "/compare", label: "Compare" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, loading, hydrate, logout } = useAuth();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!loading && !user) window.location.replace(runtimePath("/login"));
  }, [loading, user]);

  if (loading) return <div className="center-screen">Loading…</div>;
  if (!user) return <div className="center-screen">Redirecting…</div>;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Pointer</div>
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`nav-link ${pathname.startsWith(item.href) ? "active" : ""}`}
          >
            {item.label}
          </Link>
        ))}
        {user.role === "admin" && <Link href="/admin" className={`nav-link ${pathname.startsWith("/admin") ? "active" : ""}`}>Admin</Link>}
        <div className="sidebar-footer">
          <ThemeSelector />
          <a className="third-party-link" href="/icons/brands/NOTICE.txt" target="_blank" rel="noreferrer">
            Icon licences
          </a>
          <div className="muted" style={{ marginBottom: 8 }}>
            {user.name}
            <br />
            <span className="mono">{user.email}</span>
          </div>
          <button className="btn-sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
