import { NextResponse } from "next/server";

const optionalEnv = (name: string): string | null => {
  const value = process.env[name]?.trim();
  return value ? value : null;
};

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    component: "web",
    version: optionalEnv("POINTER_COMPONENT_VERSION") ?? "0.1.0",
    build: {
      repository: optionalEnv("POINTER_BUILD_REPOSITORY"),
      branch: optionalEnv("POINTER_BUILD_BRANCH"),
      commit: optionalEnv("POINTER_BUILD_COMMIT"),
      builtAt: optionalEnv("POINTER_BUILD_AT"),
    },
  });
}
