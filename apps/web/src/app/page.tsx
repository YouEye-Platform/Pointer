"use client";
import { usePointerTranslations } from "@/lib/i18n";

import { useEffect } from "react";
import { getToken, runtimePath } from "@/lib/api";

export default function Home() {
  const translateInterface = usePointerTranslations();

  useEffect(() => {
    window.location.replace(runtimePath(getToken() ? "/dashboard" : "/login"));
  }, []);
  return <div className="center-screen">{translateInterface("Loading…")}</div>;
}
