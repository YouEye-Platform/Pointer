export type ConnectionAccount = {
  hasCredential?: boolean; isMain?: boolean; needsReauth?: boolean;
  paused?: boolean;
};

export function accountConnection(accounts: ConnectionAccount[]) {
  const configured = accounts.filter(account => account.hasCredential);
  if (!configured.length) return { setup: false, label: "Sign-in required" };
  if (configured.every(account => account.needsReauth)) return { setup: true, label: "Sign-in required" };
  if (configured.every(account => account.paused || account.needsReauth)) return { setup: true, label: "Paused" };
  return { setup: true, label: "Connected" };
}
