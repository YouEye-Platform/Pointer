import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, lstat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../src/db";
import { decrypt } from "../src/services/encryption";
import { parseProviderCredential } from "../src/services/provider-credential-codec";

const planSchema = z.object({ database: z.string().regex(/^[A-Za-z0-9_-]+$/),
  accounts: z.array(z.object({ id: z.string().min(1), owner: z.string().min(1),
    provider: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
    adapter: z.enum(["openai-chat", "openai-responses", "anthropic-messages"]),
    baseUrl: z.string().url(), authMode: z.enum(["key", "forward", "oauth"]).optional(),
  })).min(1),
});
const identity = (prefix: string, ...parts: string[]) => prefix + createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

async function main() {
  process.umask(0o077);
  const args = Bun.argv.slice(2);
  const planPath = args[args.indexOf("--plan") + 1];
  const root = process.env.POINTER_ENGINE_STATE_DIR;
  const apply = args.includes("--apply-stopped");
  if (!args.includes("--plan") || !planPath || !root || !isAbsolute(root)) throw new Error("Use --plan <file>, POINTER_ENGINE_STATE_DIR and optional --apply-stopped after stopping all Pointer writers");
  const plan = planSchema.parse(JSON.parse(await readFile(planPath, "utf8")));
  if (new URL(process.env.DATABASE_URL!).pathname !== "/" + plan.database) throw new Error("Database identity mismatch");
  const seen = new Set<string>();
  type CodexImport = { id: string; credential: { accessToken: string; refreshToken: string; expiresAt: number; chatgptAccountId: string } };
  const accounts: Array<{ item: z.infer<typeof planSchema>["accounts"][number]; account: typeof schema.providerAccounts.$inferSelect; parsed: ReturnType<typeof parseProviderCredential> | null; codex: CodexImport | undefined; models: string[] }> = [];
  for (const item of plan.accounts) {
    const key = item.owner + ":" + item.provider;
    if (seen.has(item.id) || seen.has(key)) throw new Error("Duplicate account or engine provider");
    seen.add(item.id); seen.add(key);
    const [account] = await db.select().from(schema.providerAccounts).where(and(eq(schema.providerAccounts.id, item.id), eq(schema.providerAccounts.userId, item.owner)));
    if (!account || account.engineProvider) throw new Error("Account missing or already bound");
    const [credential] = await db.select().from(schema.providerKeys).where(eq(schema.providerKeys.providerAccountId, item.id));
    const parsed = credential ? parseProviderCredential(decrypt(credential.apiKeyEncrypted)) : null;
    if (parsed?.kind === "invalid-oauth2") throw new Error("Invalid saved account credential");
    let codex: CodexImport | undefined;
    if (parsed?.kind === "oauth2") {
      if (item.provider !== "openai" || parsed.value.issuer !== "https://auth.openai.com" || parsed.value.clientId !== "app_EMoamEEZ73f0CkXaXp7hrann" || !parsed.value.refreshToken || !parsed.value.expiresAt) throw new Error("Saved OAuth grant needs a supported explicit import");
      const claims = JSON.parse(Buffer.from(parsed.value.accessToken.split(".")[1]!, "base64url").toString("utf8"));
      const chatgptAccountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? claims.chatgpt_account_id ?? claims.account_id;
      if (typeof chatgptAccountId !== "string" || !chatgptAccountId) throw new Error("Saved Codex account identity is missing");
      codex = { id: item.id, credential: { accessToken: parsed.value.accessToken, refreshToken: parsed.value.refreshToken, expiresAt: Date.parse(parsed.value.expiresAt), chatgptAccountId } };
    }
    const available = await db.select({ model: schema.providerModels.providerModelId }).from(schema.providerAccountModels).innerJoin(schema.providerModels, eq(schema.providerModels.id, schema.providerAccountModels.providerModelId)).where(eq(schema.providerAccountModels.providerAccountId, item.id));
    accounts.push({ item, account, parsed, codex, models: available.map(row => row.model) });
  }
  // Refuse to overwrite any saved engine state. A failed import is recovered
  // from the paired database/files backup, never by guessing which half won.
  const owners = [...new Set(plan.accounts.map(row => row.owner))];
  for (const owner of owners) {
    const directory = join(root, createHash("sha256").update(owner).digest("hex"));
    if (await lstat(directory).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("Target owner engine state already exists");
  }
  if (!apply) { console.log(JSON.stringify({ checked: true, accounts: accounts.length, owners: owners.length, oauthAccounts: accounts.filter(row => row.codex).length })); return; }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Engine root must be private");
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pointer-offline-account-import'))`);
    // No saved key, identity, group entry, public alias or usage row is replaced.
    for (const { item, account } of accounts) {
      const [current] = await tx.select().from(schema.providerAccounts).where(eq(schema.providerAccounts.id, item.id));
      if (!current || current.engineProvider || current.providerId !== account.providerId) throw new Error("Account changed since preflight");
      const [provider] = await tx.select().from(schema.providers).where(eq(schema.providers.id, account.providerId));
      if (!provider) throw new Error("Provider definition missing");
      const providerId = identity("ep_", item.owner, item.provider);
      await tx.insert(schema.providers).values({ ...provider, id: providerId, name: item.provider, baseUrl: item.baseUrl, isBuiltin: false, manifestPath: null, handlerId: null, handlerConfig: null });
      const models = await tx.select().from(schema.providerModels).where(eq(schema.providerModels.providerId, account.providerId));
      for (const model of models) {
        const modelId = identity("pm_", providerId, model.id);
        const metadata = { ...(model.rawMetadata as Record<string, unknown> ?? {}), engineSelector: item.provider + "/" + model.providerModelId };
        await tx.insert(schema.providerModels).values({ ...model, id: modelId, providerId, rawMetadata: metadata });
        const available = await tx.select().from(schema.providerAccountModels).where(and(eq(schema.providerAccountModels.providerAccountId, item.id), eq(schema.providerAccountModels.providerModelId, model.id)));
        for (const row of available) await tx.update(schema.providerAccountModels).set({ providerModelId: modelId, rawMetadata: { ...(row.rawMetadata as Record<string, unknown> ?? {}), engineSelector: metadata.engineSelector } }).where(eq(schema.providerAccountModels.id, row.id));
        await tx.update(schema.modelGroupEntries).set({ providerId, providerModelKey: modelId }).where(and(eq(schema.modelGroupEntries.providerAccountId, item.id), eq(schema.modelGroupEntries.providerModelKey, model.id)));
      }
      await tx.update(schema.modelGroupEntries).set({ providerId }).where(eq(schema.modelGroupEntries.providerAccountId, item.id));
      await tx.update(schema.instanceModels).set({ providerId }).where(eq(schema.instanceModels.providerAccountId, item.id));
      await tx.update(schema.providerKeys).set({ providerId }).where(eq(schema.providerKeys.providerAccountId, item.id));
      await tx.update(schema.providerAccounts).set({ providerId, engineProvider: item.provider, baseUrl: item.baseUrl }).where(eq(schema.providerAccounts.id, item.id));
    }
    for (const owner of owners) {
      const directory = join(root, createHash("sha256").update(owner).digest("hex"));
      await mkdir(directory, { mode: 0o700 });
      for (const name of ["home", "opencodex", "codex", "claude", "config", "cache", "data", "tmp"]) await mkdir(join(directory, name), { mode: 0o700 });
      const rows = accounts.filter(row => row.item.owner === owner);
      const providers = Object.fromEntries(rows.map(({ item, parsed, models }) => [item.provider, { adapter: item.adapter, baseUrl: item.baseUrl, models, ...(parsed?.kind === "api-key" ? { apiKey: parsed.value, authMode: "key" } : { authMode: item.authMode ?? "forward" }) }]));
      const codex = rows.flatMap(row => row.codex ? [row.codex] : []);
      const config = { providers, defaultProvider: rows[0]!.item.provider, port: 0, hostname: "127.0.0.1", clientIntegrations: { codex: false, grok: false, "claude-desktop": false }, catalogAutoRefresh: { enabled: false }, appOwnedMemoryBudgetMb: 64, webSearchSidecar: { enabled: false }, visionSidecar: { enabled: false }, ...(codex.length ? { codexAccounts: codex.map(row => ({ id: row.id, email: "", chatgptAccountId: row.credential.chatgptAccountId, isMain: false })), activeCodexAccountId: codex[0]!.id } : {}) };
      await writeFile(join(directory, "opencodex/config.json"), JSON.stringify(config), { flag: "wx", mode: 0o600 });
      if (codex.length) {
        const worker = fileURLToPath(new URL("./import-codex.ts", import.meta.resolve("@pointer/engine")));
        const result = spawnSync(process.execPath, [worker], { input: JSON.stringify(codex), stdio: ["pipe", "ignore", "ignore"], env: { PATH: process.env.PATH, HOME: join(directory, "home"), OPENCODEX_HOME: join(directory, "opencodex"), CODEX_HOME: join(directory, "codex"), CLAUDE_CONFIG_DIR: join(directory, "claude"), XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"), XDG_DATA_HOME: join(directory, "data"), TMPDIR: join(directory, "tmp"), OCX_DISABLE_UPDATE_CHECK: "1" } });
        if (result.status !== 0) throw new Error("Offline Codex import failed");
      }
    }
  });
  console.log(JSON.stringify({ imported: true, accounts: accounts.length, owners: owners.length, networkRequests: 0 }));
}
try { await main(); process.exit(0); }
catch (error) { console.error(JSON.stringify({ failed: true, reason: "Offline import rejected; protected details withheld", recovery: "Restore the paired database and engine-state backup before retrying" })); process.exit(1); }
