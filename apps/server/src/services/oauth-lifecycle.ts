import { OAuthCredentialRefreshError, type OAuthCredential } from "../providers/types";
import type { StoredOAuthCredential } from "./provider-credential-codec";

export type RenewableCredential = StoredOAuthCredential & {
  lastRefreshAt?: string;
  refreshState?: "reconnect_required" | "temporarily_unavailable";
  retryAfter?: string;
};

// Unverified JWT expiry is a scheduling hint, never identity proof.
export function accessTokenExpiry(token: string): string | undefined {
  try {
    const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp;
    if (typeof exp === "number" && Number.isFinite(exp) && exp > 0)
      return new Date(exp * 1000).toISOString();
  } catch { /* Opaque access tokens need explicit provider expiry. */ }
  return undefined;
}

export function credentialStatus(credential: RenewableCredential) {
  return {
    status: credential.refreshState ?? (!credential.refreshToken ? "reconnect_required" : "connected"),
    expiresAt: credential.expiresAt ?? accessTokenExpiry(credential.accessToken) ?? null,
    lastRefreshAt: credential.lastRefreshAt ?? null,
    refreshable: Boolean(credential.refreshToken),
  };
}

// Caller serializes per credential and persists the result atomically.
export async function renewOAuth(
  credential: RenewableCredential,
  refresh: ((credential: OAuthCredential) => Promise<OAuthCredential>) | undefined,
  now = Date.now(),
): Promise<{ accessToken: string | null; updated?: RenewableCredential }> {
  const expiry = Date.parse(credential.expiresAt ?? accessTokenExpiry(credential.accessToken) ?? "");
  const usable = Number.isFinite(expiry) && expiry > now;
  if (expiry > now + 120_000) return { accessToken: credential.accessToken };
  if (credential.refreshState === "reconnect_required")
    return { accessToken: usable ? credential.accessToken : null };
  if (Date.parse(credential.retryAfter ?? "") > now)
    return { accessToken: usable ? credential.accessToken : null };
  if (!refresh || !credential.refreshToken)
    return { accessToken: usable ? credential.accessToken : null,
      updated: { ...credential, refreshState: "reconnect_required" } };
  try {
    const result = await refresh(credential);
    if (!result.accessToken) throw new Error("Empty refresh response");
    const expiresAt = result.expiresAt ?? accessTokenExpiry(result.accessToken);
    const updated: RenewableCredential = {
      ...credential, ...result,
      refreshToken: result.refreshToken ?? credential.refreshToken,
      expiresAt: expiresAt ?? new Date(now + 5 * 60_000).toISOString(),
      lastRefreshAt: new Date(now).toISOString(),
      refreshState: undefined, retryAfter: undefined,
    };
    return { accessToken: updated.accessToken, updated };
  } catch (error) {
    const terminal = error instanceof OAuthCredentialRefreshError && error.terminal;
    return { accessToken: usable ? credential.accessToken : null, updated: {
      ...credential,
      refreshState: terminal ? "reconnect_required" : "temporarily_unavailable",
      retryAfter: terminal ? undefined : new Date(now + 30_000).toISOString(),
    } };
  }
}
