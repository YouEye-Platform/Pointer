import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output so the deploy VM can run `node .next/standalone/server.js`
  // with only Bun/Node present — no pnpm install on the box.
  output: "standalone",
  outputFileTracingRoot: path.join(projectDirectory, "../.."),
  transpilePackages: ["@pointer/contracts"],
  reactStrictMode: true,
  // Compression is handled by the upstream reverse proxy (NPM/nginx) in
  // production. Disabling Next's own gzip keeps proxied API bodies uncompressed,
  // which some tunnels/proxies require to forward response bodies intact.
  compress: false,

  // LOCAL DEV ONLY: when API_PROXY_TARGET is set, proxy backend routes to the
  // server so the browser can reach it same-origin (useful behind the AnyAgent
  // preview path-proxy). Production uses the deployment router instead.
  async rewrites() {
    const target = process.env.API_PROXY_TARGET;
    if (!target) return [];
    return [
      { source: "/api/:path*", destination: `${target}/api/:path*` },
      { source: "/v1/:path*", destination: `${target}/v1/:path*` },
      { source: "/v1beta/:path*", destination: `${target}/v1beta/:path*` },
      { source: "/.well-known/pointer", destination: `${target}/.well-known/pointer` },
    ];
  },
};

export default nextConfig;
