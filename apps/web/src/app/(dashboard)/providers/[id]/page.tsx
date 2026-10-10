"use client";
import { useParams } from "next/navigation";
import { ProviderDetail } from "@/components/EngineProviders";
export default function ProviderPage() {
  const { id } = useParams<{ id: string }>();
  return <ProviderDetail key={id} id={id} />;
}
