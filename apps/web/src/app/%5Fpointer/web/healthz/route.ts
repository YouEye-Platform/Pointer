import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    component: "web",
    version: process.env.POINTER_COMPONENT_VERSION?.trim() || "0.1.0",
    timestamp: new Date().toISOString(),
  });
}
