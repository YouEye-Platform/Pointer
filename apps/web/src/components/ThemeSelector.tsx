"use client";

import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
const STORAGE_KEY = "pointer_theme";

function applyTheme(mode: ThemeMode) {
  const resolved = mode === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.style.colorScheme = resolved;
}

export function ThemeSelector() {
  const [mode, setMode] = useState<ThemeMode>("system");

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const initial: ThemeMode = saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    setMode(initial);
    applyTheme(initial);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const current = (localStorage.getItem(STORAGE_KEY) || "system") as ThemeMode;
      if (current === "system") applyTheme("system");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  function choose(next: ThemeMode) {
    localStorage.setItem(STORAGE_KEY, next);
    setMode(next);
    applyTheme(next);
  }

  return (
    <fieldset className="theme-selector" aria-label="Color theme">
      <legend>Theme</legend>
      {(["light", "dark", "system"] as const).map((option) => (
        <button
          key={option}
          type="button"
          className={mode === option ? "active" : ""}
          aria-pressed={mode === option}
          onClick={() => choose(option)}
        >
          {option.charAt(0).toUpperCase() + option.slice(1)}
        </button>
      ))}
    </fieldset>
  );
}
