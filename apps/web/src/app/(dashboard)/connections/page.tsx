"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
export default function ConnectionsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/providers"); }, [router]);
  return null;
}
