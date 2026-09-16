import type { OAuthCredential } from "../providers/types";

const OAUTH_CREDENTIAL_KIND = "pointer-provider-oauth2";
const OAUTH_CREDENTIAL_VERSION = 1;

export interface StoredOAuthCredential extends OAuthCredential {
  kind: typeof OAUTH_CREDENTIAL_KIND;
  version: typeof OAUTH_CREDENTIAL_VERSION;
  issuer: string;
  clientId: string;
}

export type ParsedProviderCredential =
  | { kind: "api-key"; value: string }
  | { kind: "oauth2"; value: StoredOAuthCredential }
  | { kind: "invalid-oauth2" };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseProviderCredential(value: string): ParsedProviderCredential {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed
      && typeof parsed === "object"
      && (parsed as Record<string, unknown>).kind === OAUTH_CREDENTIAL_KIND
      && (parsed as Record<string, unknown>).version === OAUTH_CREDENTIAL_VERSION
      && nonEmptyString((parsed as Record<string, unknown>).accessToken)
      && nonEmptyString((parsed as Record<string, unknown>).issuer)
      && nonEmptyString((parsed as Record<string, unknown>).clientId)
      && (
        (parsed as Record<string, unknown>).expiresAt === undefined
        || (
          nonEmptyString((parsed as Record<string, unknown>).expiresAt)
          && Number.isFinite(
            Date.parse((parsed as Record<string, unknown>).expiresAt as string)
          )
        )
      )
    ) {
      return { kind: "oauth2", value: parsed as StoredOAuthCredential };
    }
    if (
      parsed
      && typeof parsed === "object"
      && (parsed as Record<string, unknown>).kind === OAUTH_CREDENTIAL_KIND
    ) {
      return { kind: "invalid-oauth2" };
    }
  } catch {
    // Legacy provider keys are deliberately plain strings after decryption.
  }
  return { kind: "api-key", value };
}

export function serializeOAuthCredential(
  credential: OAuthCredential,
  issuer: string,
  clientId: string
): string {
  if (!nonEmptyString(credential.accessToken)) {
    throw new Error("OAuth access token is required");
  }
  if (!nonEmptyString(issuer) || !nonEmptyString(clientId)) {
    throw new Error("OAuth issuer and client ID are required");
  }
  if (
    credential.expiresAt
    && !Number.isFinite(Date.parse(credential.expiresAt))
  ) {
    throw new Error("OAuth credential expiry is invalid");
  }
  const stored: StoredOAuthCredential = {
    kind: OAUTH_CREDENTIAL_KIND,
    version: OAUTH_CREDENTIAL_VERSION,
    issuer,
    clientId,
    accessToken: credential.accessToken,
    ...(credential.refreshToken ? { refreshToken: credential.refreshToken } : {}),
    ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
    ...(credential.tokenType ? { tokenType: credential.tokenType } : {}),
    ...(credential.scope ? { scope: credential.scope } : {}),
    ...(credential.userId ? { userId: credential.userId } : {}),
  };
  return JSON.stringify(stored);
}
