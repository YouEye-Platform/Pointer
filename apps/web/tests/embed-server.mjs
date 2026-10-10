import { resolve } from "node:path";
const web = resolve(import.meta.dirname, "..");
const fixture = resolve(web, "../../.staging/embed");
const build = await Bun.build({ entrypoints: [resolve(web, "tests/embed-host.tsx")], outdir: fixture,
  target: "browser", define: { "process.env.NODE_ENV": '"production"' } });
if (!build.success) throw new AggregateError(build.logs, "Host fixture build failed");
Bun.serve({ hostname: "127.0.0.1", port: 3202, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response('<!doctype html><html data-theme="light"><head><style>body{font:16px sans-serif;background:#fff;color:#123456}button{color:#123456}section{width:480px;display:inline-block;vertical-align:top}</style></head><body><div id="host"></div><section id="pointer-one"></section><section id="pointer-two"></section><script type="module" src="/fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
  const file = path === "/fixture.js" ? resolve(fixture, "embed-host.js") : resolve(web, "public", "." + path);
  if (!file.startsWith(web + "/public/") && path !== "/fixture.js") return new Response(null, { status: 404 });
  const data = Bun.file(file);
  return await data.exists() ? new Response(data) : new Response(null, { status: 404 });
} });
