"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/store";
import { ThemeSelector } from "@/components/ThemeSelector";
import { runtimePath } from "@/lib/api";
import { assetPath, navigatePointer } from "@/lib/host-runtime";

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
  { href: "/diagnostics", label: "Request diagnostics" },
  { href: "/routing", label: "Search and vision" },
  { href: "/compare", label: "Compare" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, loading, hydrate, logout } = useAuth();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => { setNavigationOpen(false); }, [pathname]);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!loading && !user) navigatePointer(runtimePath("/login"));
  }, [loading, user]);

  if (loading) return <div className="center-screen">Loading…</div>;
  if (!user) return <div className="center-screen">Redirecting…</div>;

  return (
    <div className="shell">
      <aside className="sidebar" onKeyDown={(event) => {
        if (event.key === "Escape" && navigationOpen) {
          setNavigationOpen(false);
          menuButton.current?.focus();
        }
      }}>
        <div className="sidebar-heading">
          <div className="brand">Pointer</div>
          <button ref={menuButton} className="navigation-toggle" aria-expanded={navigationOpen}
            aria-controls="pointer-navigation" onClick={() => setNavigationOpen(!navigationOpen)}>
            {navigationOpen ? "Close menu" : "Menu"}
          </button>
        </div>
        <div id="pointer-navigation" className={`sidebar-content ${navigationOpen ? "is-open" : ""}`}>
        <nav aria-label="Pointer">
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
        </nav>
        <div className="sidebar-footer">
          <ThemeSelector />
          <a className="third-party-link" href="https://opencodex.me/" target="_blank" rel="noreferrer">Powered by OpenCodex · MIT</a>
          <a className="third-party-link" href={assetPath("/icons/brands/NOTICE.txt")} target="_blank" rel="noreferrer">
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
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
