"use client";
import { usePointerTranslations } from "@/lib/i18n";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/store";
import { ThemeSelector } from "@/components/ThemeSelector";
import { runtimePath } from "@/lib/api";
import { assetPath, getHostRuntime, navigatePointer } from "@/lib/host-runtime";

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/models", label: "Models" },
  { href: "/providers", label: "Providers" },
  { href: "/instances", label: "Instances/API" },
  { href: "/groups", label: "Model Groups" },
  { href: "/test-model", label: "Test model" },
  { href: "/routing", label: "Search and vision" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const translateInterface = usePointerTranslations();

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

  if (loading) return <div className="center-screen">{translateInterface("Loading…")}</div>;
  if (!user) return <div className="center-screen">{translateInterface("Redirecting…")}</div>;

  if (getHostRuntime()?.navigation === "host") return (
    <div className="settings-content">
      <div className="settings-page">{children}</div>
      <footer className="settings-attribution">
        <a href="https://opencodex.me/" target="_blank" rel="noreferrer">{translateInterface("OpenCodex · MIT")}</a>
        <a href={assetPath("/icons/brands/NOTICE.txt")} target="_blank" rel="noreferrer">{translateInterface("Icon licences")}</a>
      </footer>
    </div>
  );

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
            {navigationOpen ? translateInterface("Close menu") : translateInterface("Menu")}
          </button>
        </div>
        <div id="pointer-navigation" className={`sidebar-content ${navigationOpen ? "is-open" : ""}`}>
        <nav aria-label="Pointer">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={(pathname.startsWith(item.href) || item.href === "/instances" && pathname.startsWith("/keys")) ? "page" : undefined}
            className={`nav-link ${(pathname.startsWith(item.href) || item.href === "/instances" && pathname.startsWith("/keys")) ? "active" : ""}`}
          >
            {translateInterface(item.label)}
          </Link>
        ))}
        {user.role === "admin" && <Link href="/admin" className={`nav-link ${pathname.startsWith("/admin") ? "active" : ""}`}>{translateInterface("Admin")}</Link>}
        </nav>
        <div className="sidebar-footer">
          <ThemeSelector />
          <a className="third-party-link" href="https://opencodex.me/" target="_blank" rel="noreferrer">{translateInterface("Powered by OpenCodex · MIT")}</a>
          <a className="third-party-link" href={assetPath("/icons/brands/NOTICE.txt")} target="_blank" rel="noreferrer">
            {translateInterface("Icon licences")}</a>
          <div className="muted" style={{ marginBottom: 8 }}>
            {user.name}
            <br />
            <span className="mono">{user.email}</span>
          </div>
          <button className="btn-sm" onClick={logout}>
            {translateInterface("Sign out")}</button>
        </div>
        </div>
      </aside>
      <main className="main"><div className="pointer-page" data-screen={pathname.split("/")[1] || "dashboard"}>{children}</div></main>
    </div>
  );
}
