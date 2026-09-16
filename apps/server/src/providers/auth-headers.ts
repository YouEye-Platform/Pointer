import type { ProviderManifest } from "./types";

export function providerAuthHeaders(
  manifest: ProviderManifest,
  credential: string
): Record<string, string> {
  const authType = manifest.auth?.type;
  if (
    manifest.type === "anthropic-compatible"
    && authType === "bearer"
    && !manifest.auth?.header
  ) {
    return {
      "x-api-key": credential,
      "anthropic-version": "2023-06-01",
    };
  }
  if (
    authType === "bearer"
    || authType === "oauth-device-flow"
    || authType === "oauth-pkce"
  ) {
    return {
      [manifest.auth?.header || "Authorization"]: `Bearer ${credential}`,
    };
  }
  if (authType === "header" && manifest.auth?.header) {
    return { [manifest.auth.header]: credential };
  }
  return {};
}
