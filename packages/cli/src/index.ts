#!/usr/bin/env bun
// Pointer CLI — a thin HTTP client of Pointer server. The server remains the sole
// backend authority; the CLI only calls its endpoints (which also makes every
// command a live smoke test of the running server).
import { loadConfig, saveConfig, configPath, type CliConfig } from "./config";

const VERSION = "0.1.0";

// ── tiny arg parser: splits positionals from --flags (--flag value | --flag=value | --bool) ──
interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}
function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out.flags[key] = next;
          i++;
        } else {
          out.flags[key] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function flag(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return (await Bun.stdin.text()).trim();
}

// ── HTTP helpers ──────────────────────────────────────────────
interface ReqOpts {
  method?: string;
  token?: string; // JWT
  apiKey?: string; // ptr_ key
  body?: unknown;
}
async function api(cfg: CliConfig, path: string, opts: ReqOpts = {}): Promise<any> {
  const res = await request(cfg, path, opts);
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const detail = json?.error?.message || json?.error || json || res.statusText;
    die(`${opts.method || "GET"} ${path} -> ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return json;
}
async function request(cfg: CliConfig, path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;
  return fetch(`${cfg.apiUrl}${path}`, {
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

function requireToken(cfg: CliConfig): string {
  if (!cfg.token) die("not logged in — run `pointer bootstrap` or `pointer login` first");
  return cfg.token;
}
function requireApiKey(cfg: CliConfig): string {
  if (!cfg.apiKey) die("no ptr_ API key saved — run `pointer bootstrap` first");
  return cfg.apiKey;
}

// ── commands ──────────────────────────────────────────────────

async function cmdConfig(args: Args, cfg: CliConfig) {
  const url = flag(args, "api-url");
  if (url) {
    cfg.apiUrl = url.replace(/\/$/, "");
    await saveConfig(cfg);
    console.log(`api-url set to ${cfg.apiUrl}`);
    return;
  }
  console.log(`config: ${configPath()}`);
  console.log(`  apiUrl:     ${cfg.apiUrl}`);
  console.log(`  user:       ${cfg.userEmail ?? "(none)"}`);
  console.log(`  instanceId: ${cfg.instanceId ?? "(none)"}`);
  console.log(`  token:      ${cfg.token ? "(saved)" : "(none)"}`);
  console.log(`  apiKey:     ${cfg.apiKey ? cfg.apiKey.slice(0, 8) + "…" : "(none)"}`);
}

async function cmdBootstrap(args: Args, cfg: CliConfig) {
  const email = flag(args, "email") || die("--email is required");
  const password = flag(args, "password") || die("--password is required");
  const name = flag(args, "name") || "Admin";
  const instanceName = flag(args, "instance") || "Default";

  // 1. Register the (first) user. Registration is open; the first user is admin.
  const reg = await api(cfg, "/api/auth/register", { body: { email, password, name } });
  const token = reg.token as string;
  if (!token) die("registration did not return a token");

  // 2. Ensure a default model group exists (auto-created on first access) so the
  //    new instance links to it and is ready to receive models.
  await api(cfg, "/api/groups/default", { token });

  // 3. Create an instance (auto-links the user's default group).
  const inst = await api(cfg, "/api/instances", { token, body: { name: instanceName } });
  const instanceId = inst.id as string;

  // 3. Mint a ptr_ API key bound to that instance.
  const key = await api(cfg, "/api/keys", { token, body: { instanceId, name: "cli" } });

  cfg.token = token;
  cfg.apiKey = key.key;
  cfg.userEmail = email;
  cfg.instanceId = instanceId;
  await saveConfig(cfg);

  console.log("bootstrap complete:");
  console.log(`  user:     ${email}`);
  console.log(`  instance: ${instanceId}`);
  console.log(`  api key:  ${key.key}`);
  console.log(`  (saved to ${configPath()})`);
  console.log("\nnext: add a provider ->  pointer provider add <manifestId> --key <provider-key>");
}

async function cmdLogin(args: Args, cfg: CliConfig) {
  const email = flag(args, "email") || die("--email is required");
  const password = flag(args, "password") || die("--password is required");
  const res = await api(cfg, "/api/auth/login", { body: { email, password } });
  cfg.token = res.token;
  cfg.userEmail = email;
  await saveConfig(cfg);
  console.log(`logged in as ${email}`);
}

async function cmdWhoami(_args: Args, cfg: CliConfig) {
  const me = await api(cfg, "/api/auth/me", { token: requireToken(cfg) });
  console.log(`${me.name} <${me.email}>  role=${me.role}  id=${me.id}`);
}

async function cmdProvider(args: Args, cfg: CliConfig) {
  const sub = args._[0];
  if (sub === "manifests") {
    const manifests = await api(cfg, "/api/providers/manifests", { token: requireToken(cfg) });
    for (const m of manifests) {
      console.log(`  ${String(m.id).padEnd(18)} ${m.name}  [${m.type}]`);
    }
    return;
  }
  if (sub === "list") {
    const providers = await api(cfg, "/api/providers", { token: requireToken(cfg) });
    if (!providers.length) {
      console.log("no active providers — add one with `pointer provider add <manifestId> --key <key>`");
      return;
    }
    for (const p of providers) {
      const keyState = p.hasKey ? "key✓" : "no-key";
      console.log(`  ${String(p.id).padEnd(18)} ${p.name}  [${keyState}]`);
    }
    return;
  }
  if (sub === "add") {
    const manifestId = args._[1] || die("usage: pointer provider add <manifestId> --key <apiKey> [--label L]");
    const apiKey = flag(args, "key") || die("--key <provider-api-key> is required");
    const label = flag(args, "label") || "Default";
    const res = await api(cfg, "/api/providers/from-manifest", {
      token: requireToken(cfg),
      body: { manifestId, apiKey, label },
    });
    console.log(`provider '${manifestId}' added (id=${res.id ?? manifestId}); model sync triggered.`);
    return;
  }
  die("usage: pointer provider <manifests|list|add>");
}

async function cmdModels(_args: Args, cfg: CliConfig) {
  const res = await request(cfg, "/v1/models", { apiKey: requireApiKey(cfg) });
  const json: any = await res.json();
  if (!res.ok) die(`/v1/models -> ${res.status}: ${JSON.stringify(json)}`);
  const data = json.data || [];
  if (!data.length) {
    console.log("no models available to this key — add a provider and models to your instance/group first");
    return;
  }
  for (const m of data) {
    const ctx = m.context_window ? `${m.context_window} ctx` : "";
    console.log(`  ${m.id}${ctx ? "  (" + ctx + ")" : ""}`);
  }
}

function extractPrompt(args: Args, stdin: string): string {
  // Prompt = positional args after the model, else stdin.
  const positional = args._.slice(1).join(" ").trim();
  return positional || stdin;
}

async function cmdComplete(args: Args, cfg: CliConfig, stdin: string) {
  const model = args._[0] || die("usage: pointer complete <model> [prompt]");
  const prompt = extractPrompt(args, stdin) || die("no prompt (pass as argument or via stdin)");
  const res = await request(cfg, "/v1/chat/completions", {
    apiKey: requireApiKey(cfg),
    body: { model, messages: [{ role: "user", content: prompt }], stream: false },
  });
  const json: any = await res.json();
  if (!res.ok) die(`/v1/chat/completions -> ${res.status}: ${JSON.stringify(json.error ?? json)}`);
  const content = json.choices?.[0]?.message?.content ?? "(no content)";
  console.log(content);
}

async function cmdChat(args: Args, cfg: CliConfig, stdin: string) {
  const model = args._[0] || die("usage: pointer chat <model> [prompt]");
  const prompt = extractPrompt(args, stdin) || die("no prompt (pass as argument or via stdin)");
  const res = await request(cfg, "/v1/chat/completions", {
    apiKey: requireApiKey(cfg),
    body: { model, messages: [{ role: "user", content: prompt }], stream: true },
  });
  if (!res.ok || !res.body) {
    const t = await res.text();
    die(`/v1/chat/completions -> ${res.status}: ${t}`);
  }
  // Stream SSE, print content deltas as they arrive (streaming smoke test).
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        process.stdout.write("\n");
        return;
      }
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) process.stdout.write(delta);
      } catch {
        // ignore non-JSON keepalive lines
      }
    }
  }
  process.stdout.write("\n");
}

function usage() {
  console.log(`pointer ${VERSION} — Pointer CLI

Usage: pointer <command> [args]

Setup
  config [--api-url URL]                 Show config, or set the API base URL
  bootstrap --email E --password P [--name N] [--instance NAME]
                                         Register first user, create instance, mint ptr_ key
  login --email E --password P           Log in and save the JWT
  whoami                                 Show the logged-in user

Providers
  provider manifests                     List available provider manifests
  provider list                          List active providers
  provider add <manifestId> --key KEY [--label L]
                                         Add a provider from a manifest (triggers model sync)

Proxy (uses the saved ptr_ key)
  models                                 List models available to your key
  complete <model> [prompt]              One-shot completion (non-streaming)
  chat <model> [prompt]                  Streaming completion (SSE)

Config file: ${configPath()}
Env: POINTER_API_URL, POINTER_CONFIG`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    usage();
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    console.log(VERSION);
    return;
  }

  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const cfg = await loadConfig();
  const stdin = command === "complete" || command === "chat" ? await readStdin() : "";

  switch (command) {
    case "config":
      return cmdConfig(args, cfg);
    case "bootstrap":
      return cmdBootstrap(args, cfg);
    case "login":
      return cmdLogin(args, cfg);
    case "whoami":
      return cmdWhoami(args, cfg);
    case "provider":
      return cmdProvider(args, cfg);
    case "models":
      return cmdModels(args, cfg);
    case "complete":
      return cmdComplete(args, cfg, stdin);
    case "chat":
      return cmdChat(args, cfg, stdin);
    default:
      console.error(`unknown command: ${command}\n`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => die(err?.message || String(err)));
