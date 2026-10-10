import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isManagementOperation } from "./management";

export type EngineConfig = {
  providers: Record<string, Record<string, unknown>>;
  defaultProvider: string;
};

const inferencePaths = new Set([
  "/v1/models", "/v1/responses", "/v1/chat/completions",
  "/v1/messages", "/v1/messages/count_tokens", "/v1/responses/compact",
]);

/** Internal runtime handle. Never serialize it or return it to an API client. */
export class EngineProcess {
  /** Trusted process observation only; no heartbeat inference or child logs. */
  observation() {
    return { generation: this.generation, startedAt: this.startedAt,
      engineVersion: "2.79.0", exitCode: this.child.exitCode, signal: this.child.signalCode };
  }
  private constructor(
    private child: ChildProcess,
    private address: string,
    private adminToken: string,
    private admissionToken: string,
    private generation = randomBytes(16).toString("hex"),
    private startedAt = new Date().toISOString(),
  ) {}

  static async start(stateDirectory: string, initialConfig: EngineConfig): Promise<EngineProcess> {
    if (!isAbsolute(stateDirectory)) throw new Error("Engine state directory must be absolute");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const state = await lstat(stateDirectory);
    if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0)
      throw new Error("Engine state must be a private directory");
    const root = await realpath(stateDirectory);
    const homes: Record<string, string> = {};
    for (const name of ["home", "opencodex", "codex", "claude", "config", "cache", "data", "tmp"]) {
      homes[name] = join(root, name);
      await mkdir(homes[name]!, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      const entry = await lstat(homes[name]!);
      if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0)
        throw new Error("Engine child home must be a private directory");
    }
    const configPath = join(homes.opencodex!, "config.json");
    const config = {
      ...initialConfig,
      port: 0, hostname: "127.0.0.1",
      clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
      catalogAutoRefresh: { enabled: false },
      appOwnedMemoryBudgetMb: 64,
    };
    try {
      await writeFile(configPath, JSON.stringify(config), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const configStat = await lstat(configPath);
    if (!configStat.isFile() || configStat.isSymbolicLink() || (configStat.mode & 0o077) !== 0)
      throw new Error("Engine configuration must be a private regular file");
    // Never overwrite saved account/configuration state on restart. Refuse a
    // persisted bind/injection change instead of silently expanding authority.
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    if (saved.hostname !== "127.0.0.1" || saved.port !== 0 || saved.runtimeRole === "client"
      || saved.unauthenticatedLoopbackListener?.enabled || saved.remoteGui?.enabled
      || ["codex", "grok", "claude-desktop"].some(key => saved.clientIntegrations?.[key] !== false))
      throw new Error("Engine configuration violates the managed process boundary");

    const adminToken = `ocx_admin_${randomBytes(32).toString("base64url")}`;
    const admissionToken = randomBytes(32).toString("base64url");
    const startedAt = new Date().toISOString(), generation = randomBytes(16).toString("hex");
    const child = spawn(process.execPath, [fileURLToPath(new URL("./worker.ts", import.meta.url))], {
      cwd: root,
      // This is the child's complete environment. No inherited provider keys,
      // operator client homes, proxy credentials or native authentication.
      env: {
        PATH: process.env.PATH, HOME: homes.home,
        OPENCODEX_HOME: homes.opencodex, CODEX_HOME: homes.codex,
        CLAUDE_CONFIG_DIR: homes.claude,
        XDG_CONFIG_HOME: homes.config, XDG_CACHE_HOME: homes.cache, XDG_DATA_HOME: homes.data,
        TMPDIR: homes.tmp, OCX_DISABLE_UPDATE_CHECK: "1",
        OPENCODEX_ADMIN_AUTH_TOKEN: adminToken, OPENCODEX_API_AUTH_TOKEN: admissionToken,
      },
      // Upstream log text is not a public diagnostic boundary. Exit/readiness
      // are observed without collecting provider payloads or credential output.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => { finish(); reject(new Error("Engine startup timed out")); }, 20000);
        const finish = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); child.off("error", fail); };
        const fail = () => { finish(); reject(new Error("Engine process could not start")); };
        const exit = () => { finish(); reject(new Error("Engine exited before readiness")); };
        const message = (value: unknown) => {
          const row = value as { type?: string; port?: number };
          if (row?.type !== "listening" || !Number.isInteger(row.port) || row.port! <= 0 || row.port! > 65535) return;
          finish(); resolve(row.port!);
        };
        child.once("error", fail); child.once("exit", exit); child.on("message", message);
      });
      const handle = new EngineProcess(child, `http://127.0.0.1:${port}`, adminToken, admissionToken, generation, startedAt);
      const response = await fetch(`${handle.address}/readyz`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Engine did not report ready");
      return handle;
    } catch (error) {
      await terminate(child);
      throw error;
    }
  }

  async inference(path: string, init: RequestInit = {}): Promise<Response> {
    if (!inferencePaths.has(path)) throw new Error("Unsupported engine inference route");
    return this.request(path, init, false);
  }

  async providers(): Promise<Response> {
    return this.management("/api/providers");
  }

  async management(path: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? "GET";
    if (!isManagementOperation(path, method)) throw new Error("Unsupported engine management operation");
    const compatibility = /^\/api\/providers\/([A-Za-z0-9_.-]{1,120})\/compatibility$/.exec(path);
    if (compatibility) return this.providerCompatibility(compatibility[1]!, { ...init, method });
    // Login happens in the viewing person's browser, never in the operator's
    // desktop or by silently importing a native coding client's credentials.
    const loginPath = path.split("?")[0];
    if (loginPath === "/api/oauth/login" || loginPath === "/api/codex-auth/login") {
      if (typeof init.body !== "string") throw new Error("Login requires a JSON body");
      const body = JSON.parse(init.body);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid login body");
      init = { ...init, body: JSON.stringify({ ...body, openBrowser: false,
        ...(loginPath === "/api/codex-auth/login" ? { device: true } : { addAccount: true }),
      }) };
    }
    return this.request(path, { ...init, method }, true);
  }

  private async providerCompatibility(name: string, init: RequestInit): Promise<Response> {
    let value: boolean | null = null;
    if (init.method === "PUT") {
      try {
        const body = JSON.parse(typeof init.body === "string" ? init.body : "");
        if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, "supportsResponsesCustomTools")
          || (body.supportsResponsesCustomTools !== null && typeof body.supportsResponsesCustomTools !== "boolean")) throw new Error();
        value = body.supportsResponsesCustomTools;
      } catch { return Response.json({ error: "Expected supportsResponsesCustomTools boolean or null" }, { status: 400 }); }
    }
    // Only the upstream secret-free editor DTO is read. Full configuration and
    // bulk provider writes remain unavailable through the public management API.
    const response = await this.request("/api/config", { signal: init.signal }, true);
    if (!response.ok) return Response.json({ error: "Provider settings unavailable" }, { status: 502 });
    const config = await response.json() as { defaultProvider: string; providers: Record<string, Record<string, unknown>> };
    if (!Object.hasOwn(config.providers, name)) return Response.json({ error: "Provider not found" }, { status: 404 });
    if (init.method === "GET") return Response.json({ supportsResponsesCustomTools: config.providers[name]!.supportsResponsesCustomTools ?? null });
    const providers = Object.fromEntries(Object.entries(config.providers).map(([key, row]) => {
      // These are the four presentation-only additions to safeConfigDTO's
      // provider editor projection in the pinned upstream management contract.
      const { hasApiKey, hasHeaders, xaiResponsesOptInState, initialModelSelection, ...editable } = row;
      return [key, editable];
    }));
    const baseline = { defaultProvider: config.defaultProvider, providers };
    const next = structuredClone(baseline);
    if (value === null) delete next.providers[name]!.supportsResponsesCustomTools;
    else next.providers[name]!.supportsResponsesCustomTools = value;
    // Upstream owns optimistic concurrency, secret preservation, validation,
    // persistence and live routing refresh; never rewrite its configuration file.
    return this.request("/api/providers", { method: "PUT", signal: init.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ baseline, next }) }, true);
  }

  private async request(path: string, init: RequestInit, management: boolean) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error("Engine is not running");
    const supplied = new Headers(init.headers);
    const headers = new Headers();
    for (const name of ["content-type", "accept", "anthropic-version", "anthropic-beta"])
      if (supplied.has(name)) headers.set(name, supplied.get(name)!);
    if (!management) for (const name of ["x-opencode-session", "session_id"]) {
      const identity = supplied.get(name);
      if (identity && /^ptr_session_[A-Za-z0-9_-]{43}$/.test(identity)) headers.set(name, identity);
    }
    if (management) headers.set("authorization", `Bearer ${this.adminToken}`);
    else headers.set("x-opencodex-api-key", this.admissionToken);
    return fetch(this.address + path, { ...init, headers, redirect: "error" });
  }

  async stop(): Promise<void> { await terminate(this.child); }
}

async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timer);
}
