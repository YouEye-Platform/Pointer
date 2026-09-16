"use client";
import { useEffect } from "react";
import { getToken, runtimePath } from "@/lib/api";

export default function Home() {
  useEffect(() => {
    window.location.replace(runtimePath(getToken() ? "/dashboard" : "/login"));
  }, []);
  return <div className="center-screen">Loading…</div>;
}
