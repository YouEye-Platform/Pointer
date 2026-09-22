import { createPostgresClient } from "../src/db/postgres-client";
import { transitionManagedIdentity } from "../src/services/managed-identity-transition";

// Input travels through the host's protected exec environment, never a URL or service startup flag.
async function main() {
  const args = Bun.argv.slice(2);
  if (args.length < 2 || args.length > 3 || args[0] !== "--expect-database"
    || (args.length === 3 && args[2] !== "--check")) {
    throw new Error("usage: transition-managed-identity --expect-database <name> [--check]");
  }
  const expectedDatabase = args[1]!;
  const databaseUrl = process.env.DATABASE_URL;
  const raw = process.env.POINTER_IDENTITY_TRANSITION;
  if (!databaseUrl || !raw || raw.length > 16384) throw new Error("Protected transition input is required");
  if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, "")) !== expectedDatabase) {
    throw new Error("Expected database does not match connection");
  }
  const client = createPostgresClient(databaseUrl, 1);
  try {
    const result = await transitionManagedIdentity(client, expectedDatabase, JSON.parse(raw), args[2] === "--check");
    console.log(JSON.stringify({ schema: "pointer.identity-transition.v1", result }));
  } finally { await client.end(); }
}

try { await main(); } catch {
  // Driver errors can include protected connection or query data. Return a bounded failure only.
  console.error("Managed identity transition rejected; verify database ownership, exact old identity and integration state");
  process.exitCode = 1;
}
