// Offline operator import. The parent supplies a new private engine home and
// passes credentials over stdin; this process starts no listener or refresh.
import { readFileSync } from "node:fs";
try {
  const home = process.env.OPENCODEX_HOME;
  if (!home || !home.startsWith("/") || process.env.OCX_DISABLE_UPDATE_CHECK !== "1") throw new Error();
  const input = JSON.parse(readFileSync(0, "utf8"));
  const root = import.meta.resolve("@bitkyc08/opencodex");
  // This private API is covered by the pinned-engine import acceptance check.
  const { saveCodexAccountCredential } = await import(new URL("./codex/account-store.ts", root).href);
  for (const account of input) saveCodexAccountCredential(account.id, account.credential, { validationPending: true });
} catch {
  console.error("Offline account import failed; protected input withheld");
  process.exitCode = 1;
}
