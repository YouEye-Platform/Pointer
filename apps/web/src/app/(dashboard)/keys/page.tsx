"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { usePointerTranslations } from "@/lib/i18n";

/** Keep historical links working without maintaining a second key workspace. */
export default function KeysPage() {
  const router = useRouter();
  const translateInterface = usePointerTranslations();
  useEffect(() => { router.replace("/instances"); }, [router]);
  return <p role="status">{translateInterface("API keys now belong to each instance.")} <Link href="/instances">{translateInterface("Open Instances/API")}</Link></p>;
}
