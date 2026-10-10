// Only explicit conversation identifiers are forwarded. Never derive a session
// from a request ID, API key, account, or prompt contents.
export function providerSessionId(headers: Headers): string | undefined {
  for (const name of ["x-opencode-session", "session_id", "x-session-id", "x-claude-code-session-id"]) {
    const value = headers.get(name)?.trim();
    if (value && /^[A-Za-z0-9_.:-]{1,200}$/.test(value)) return value;
  }
  return undefined;
}
