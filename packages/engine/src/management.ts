/** Upstream operations available to an authenticated Pointer account owner. */
const methods: Record<string, readonly string[]> = {
  "/api/providers": ["GET", "POST", "PATCH", "DELETE"],
  "/api/models": ["GET"],
  "/api/model-settings": ["PUT"],
  "/api/provider-context-caps": ["GET", "PUT"],
  "/api/custom-models": ["GET", "POST"],
  "/api/model-visibility": ["PUT"],
  "/api/provider-presets": ["GET"],
  "/api/key-providers": ["GET"],
  "/api/oauth/providers": ["GET"],
  "/api/oauth/login": ["POST"],
  "/api/oauth/login/cancel": ["POST"],
  "/api/oauth/login/code": ["POST"],
  "/api/oauth/status": ["GET"],
  "/api/oauth/logout": ["POST"],
  "/api/oauth/accounts": ["GET", "DELETE"],
  "/api/oauth/accounts/active": ["PUT"],
  "/api/oauth/accounts/auto-switch": ["PUT"],
  "/api/oauth/accounts/pause": ["PUT"],
  "/api/oauth/accounts/alias": ["PUT"],
  "/api/oauth/accounts/clear-cooldown": ["POST"],
  "/api/oauth/accounts/pool": ["GET", "PUT", "PATCH"],
  "/api/pool/settings": ["GET", "PUT", "PATCH"],
  "/api/providers/keys": ["GET", "POST", "DELETE"],
  "/api/providers/keys/active": ["PUT"],
  "/api/providers/keys/alias": ["PUT"],
  "/api/provider-quotas": ["GET"],
  "/api/provider-request-pacing": ["GET"],
  "/api/providers/test": ["POST"],
  "/api/logs": ["GET"],
  "/api/usage": ["GET"],
  "/api/sidecar-settings": ["GET", "PUT"],
  "/api/combos": ["GET", "PUT", "DELETE"],
  "/api/codex-auth/accounts": ["GET", "DELETE"],
  "/api/codex-auth/accounts/alias": ["PUT"],
  "/api/codex-auth/accounts/pause": ["PUT"],
  "/api/codex-auth/accounts/priority": ["PUT"],
  "/api/codex-auth/accounts/clear-cooldown": ["POST"],
  "/api/codex-auth/active": ["GET", "PUT"],
  "/api/codex-auth/auto-switch": ["PUT"],
  "/api/codex-auth/pool-strategy": ["GET", "PUT"],
  "/api/codex-auth/failover": ["PUT"],
  "/api/codex-auth/login": ["POST"],
  "/api/codex-auth/login/code": ["POST"],
  "/api/codex-auth/login/cancel": ["POST"],
  "/api/codex-auth/login-status": ["GET"],
};

export function isManagementOperation(path: string, method: string): boolean {
  // Validate before URL normalization: encoded paths and traversal cannot
  // provide another way to reach config, client-injection or credential export.
  const pathname = path.split("?")[0]!;
  const dynamic = /^\/api\/providers\/[A-Za-z0-9_.-]{1,120}\/(model-costs|model-display-names|compatibility)$/.exec(pathname);
  const custom = /^\/api\/custom-models\/[A-Za-z0-9_-]{1,120}$/.test(pathname);
  const admitted = Object.hasOwn(methods, pathname) ? methods[pathname]!.includes(method)
    : dynamic ? method === 'PUT' || (dynamic[1] !== 'model-display-names' && method === 'GET')
    : custom && ['PUT', 'DELETE'].includes(method);
  return !path.includes("#") && !/[\r\n\\]/.test(path)
    && admitted;
}
