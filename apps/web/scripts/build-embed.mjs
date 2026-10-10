import { mkdir, readFile, writeFile, rm, readdir, copyFile, cp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "public/pointer-ui");
const aliases = {
  "next/link": "navigation.tsx", "next/navigation": "navigation.tsx", "next/image": "image.tsx",
};
const result = await Bun.build({
  entrypoints: [resolve(root, "src/embed/entry.tsx")], target: "browser", format: "cjs",
  minify: true, external: ["react", "react/jsx-runtime", "react-dom/client"],
  define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' },
  plugins: [{ name: "pointer-navigation", setup(build) {
    build.onResolve({ filter: /^next\/(link|navigation|image)$/ }, ({ path }) => ({ path: resolve(root, "src/embed", aliases[path]) }));
  } }],
});
if (!result.success) throw new AggregateError(result.logs, "Pointer UI build failed");
const hash = value => createHash("sha256").update(value).digest("hex").slice(0, 16);
const iconDirectory = resolve(root, "public/icons/brands");
const iconNames = (await readdir(iconDirectory)).sort();
const iconBytes = Buffer.concat(await Promise.all(iconNames.map(async name => Buffer.concat([Buffer.from(name), await readFile(resolve(iconDirectory, name))]))));
const iconFolder = `brands-${hash(iconBytes)}`;
const code = (await result.outputs[0].text()).replaceAll("/icons/brands/", `/icons/${iconFolder}/`);
const moduleText = `// Pointer UI: host-supplied React, isolated state per factory invocation.\nexport const contract = 1;\nexport function createPointerUI(runtime) {\n  if (!runtime.React?.version?.startsWith("19.") || !runtime.createRoot) throw new Error("Pointer requires the host's React 19 runtime");\n  const React = runtime.React;\n  const jsx = (type, props, key) => React.createElement(type, key === undefined ? props : {...props, key});\n  const shared = {react: React, "react/jsx-runtime": {Fragment: React.Fragment, jsx, jsxs: jsx}, "react-dom/client": {createRoot: runtime.createRoot}};\n  const require = name => {if (!(name in shared)) throw new Error("Unknown UI dependency: " + name); return shared[name];};\n  const module = {exports: {}}; const exports = module.exports;\n${code}\n  return module.exports;\n}\n`;
const sourceCss = await readFile(resolve(root, "src/app/globals.css"), "utf8");
const fontSources = await readdir(resolve(root, "public/fonts"));
const fontCopies = [];
let fonts = (sourceCss.match(/@font-face\s*\{[^}]+\}/g) ?? []).join("\n");
for (const name of fontSources) {
  if (!/^[A-Za-z0-9_.-]+\.(?:woff2?|ttf|otf)$/.test(name)) continue;
  const path = resolve(root, "public/fonts", name);
  const hashed = `${hash(await readFile(path))}-${name}`;
  fonts = fonts.replaceAll(`/fonts/${name}`, `./fonts/${hashed}`);
  fontCopies.push([path, resolve(destination, "fonts", hashed)]);
}
const css = sourceCss.replace(/@font-face\s*\{[^}]+\}/g, "")
  .replaceAll(':root[data-theme="dark"]', ':host([data-theme="dark"])')
  .replaceAll(":root", ":host").replace(/html,\s*body\s*\{/, ".pointer-root {")
  .replaceAll("@media (max-width:", "@container (max-width:")
  + "\n:host { display:block; container-type:inline-size; isolation:isolate; }\n.pointer-root { min-height:100%; }\n";
const entry = `entry-${hash(moduleText)}.js`;
const stylesheet = `styles-${hash(css)}.css`;
const fontFile = `fonts-${hash(fonts)}.css`;
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await mkdir(resolve(destination, "fonts"));
await Promise.all([
  writeFile(resolve(destination, entry), moduleText),
  writeFile(resolve(destination, stylesheet), css),
  writeFile(resolve(destination, fontFile), fonts),
  writeFile(resolve(destination, "manifest.json"), JSON.stringify({ contract: 1, react: "19", entry, stylesheet, fonts: fontFile }, null, 2)+"\n"),
  ...fontCopies.map(([source, target]) => copyFile(source, target)),
  ...fontSources.filter(name => /^plex-(?:sans|mono)-LICENSE\.txt$/.test(name)).map(name => copyFile(resolve(root, "public/fonts", name), resolve(destination, "fonts", name))),
  cp(iconDirectory, resolve(destination, "icons", iconFolder), { recursive: true }),
]);
console.log(`Pointer UI: ${Buffer.byteLength(moduleText)} bytes; React supplied by host`);
