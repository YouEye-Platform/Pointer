import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const routerPath = resolve(root, "deployment/router/pointer-router.conf.template");
const router = readFileSync(routerPath, "utf8");
const webConfig = readFileSync(resolve(root, "apps/web/next.config.mjs"), "utf8");
const installer = readFileSync(resolve(root, "deployment/install-release.sh"), "utf8");

const inferenceLocations = [
  "location = /v1 {",
  "location ^~ /v1/ {",
  "location = /v1beta {",
  "location ^~ /v1beta/ {",
];

for (const location of inferenceLocations) {
  const start = router.indexOf(location);
  if (start < 0) throw new Error(`Pointer router is missing ${location}`);
  const next = router.indexOf("\n    location ", start + location.length);
  const block = router.slice(start, next < 0 ? router.length : next);
  for (const directive of [
    "proxy_pass http://pointer_server;",
    "proxy_buffering off;",
    "proxy_request_buffering off;",
    "proxy_read_timeout 3600s;",
    "proxy_send_timeout 3600s;",
  ]) {
    if (!block.includes(directive)) {
      throw new Error(`${location} is missing ${directive}`);
    }
  }
}

if (!webConfig.includes('source: "/v1beta/:path*"')) {
  throw new Error("Pointer web development proxy is missing /v1beta");
}

for (const route of ["/v1/models", "/v1beta/models"]) {
  if (!installer.includes(`wait_for_status http://127.0.0.1:8080${route} 401`)) {
    throw new Error(`Pointer installer does not prove ${route} reaches the server`);
  }
}

console.log("Pointer deployment router contract is aligned");
