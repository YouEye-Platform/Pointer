import { Hono } from "hono";
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Only public build outputs are served. Never accept a path or origin from an API user.
const assetName = /^(?:entry-[a-f0-9]{16}\.js|(?:styles|fonts)-[a-f0-9]{16}\.css|fonts\/[a-f0-9]{16}-[A-Za-z0-9_.-]+\.(?:woff2?|ttf|otf)|icons\/brands-[a-f0-9]{16}\/[A-Za-z0-9-]+\.svg|icons\/brands-[a-f0-9]{16}\/NOTICE\.txt)$/;

export function createUiAssetsRoutes(directory = process.env.POINTER_UI_DIR ?? "./ui",
  archives = (process.env.POINTER_UI_ARCHIVE_DIRS ?? "").split(":").filter(Boolean)) {
  const app = new Hono();
  app.get("/*", async (c) => {
    const name = c.req.path.slice(c.req.routePath.indexOf("*"));
    if (name !== "manifest.json" && !assetName.test(name)) return c.notFound();
    // The manifest always describes the current release; older hashed assets may
    // remain in administrator-configured archives for already-open clients.
    const roots = name === "manifest.json" ? [directory] : [directory, ...archives];
    for (const directory of roots) {
      try {
        const root = await realpath(resolve(directory));
        const path = await realpath(resolve(root, name));
        if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) continue;
        const type = name.endsWith(".js") ? "text/javascript; charset=utf-8"
          : name.endsWith(".css") ? "text/css; charset=utf-8"
          : name.endsWith(".json") ? "application/json; charset=utf-8"
          : name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".txt") ? "text/plain; charset=utf-8"
          : name.endsWith(".woff2") ? "font/woff2" : name.endsWith(".woff") ? "font/woff"
          : name.endsWith(".ttf") ? "font/ttf" : "font/otf";
        return new Response(Bun.file(path), { headers: {
          "content-type": type,
          "cache-control": name === "manifest.json" ? "no-store" : "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        } });
      } catch { /* missing assets fall through without disclosing filesystem paths */ }
    }
    return c.notFound();
  });
  return app;
}
