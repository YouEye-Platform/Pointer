import { test, expect } from "bun:test";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiAssetsRoutes } from "./ui-assets";
import { Hono } from "hono";

test("serves the current manifest and retained public assets without exposing other files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pointer-ui-test-"));
  try {
    const current = join(root, "current"), previous = join(root, "previous");
    await mkdir(current); await mkdir(previous);
    await writeFile(join(current, "manifest.json"), '{"contract":1}');
    await writeFile(join(previous, "manifest.json"), '{"contract":0}');
    await writeFile(join(previous, "entry-0123456789abcdef.js"), "export const contract = 1;");
    await writeFile(join(root, "private.txt"), "private fixture");
    await symlink(join(root, "private.txt"), join(current, "entry-ffffffffffffffff.js"));
    const app = createUiAssetsRoutes(current, [previous]);
    const management = new Hono().route('/_pointer/ui', app);
    expect((await management.request('/_pointer/ui/manifest.json')).status).toBe(200);
    const manifest = await app.request("/manifest.json");
    expect(await manifest.json()).toEqual({ contract: 1 });
    expect(manifest.headers.get("cache-control")).toBe("no-store");
    const script = await app.request("/entry-0123456789abcdef.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toStartWith("text/javascript");
    expect(script.headers.get("cache-control")).toContain("immutable");
    for (const path of ["/entry-ffffffffffffffff.js", "/private.txt", "/%2e%2e/private.txt", "/server.js", "/fonts/.env"]) {
      expect((await app.request(path)).status).toBe(404);
    }
  } finally { await rm(root, { recursive: true }); }
});
