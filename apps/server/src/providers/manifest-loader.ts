import { readdir, readFile } from "fs/promises";
import { join, extname } from "path";
import { parse as parseYaml } from "yaml";
import type { ProviderManifest, IProviderHandler } from "./types";
import codexHandler from "../../providers.d/_handlers/codex";
import googleGeminiHandler from "../../providers.d/_handlers/google-gemini";
import xaiGrokHandler from "../../providers.d/_handlers/xai-grok";

const MANIFESTS_DIR = process.env.POINTER_PROVIDERS_DIR?.trim()
  || join(import.meta.dir, "../../providers.d");
const HANDLERS_DIR = join(MANIFESTS_DIR, "_handlers");
const BUNDLED_HANDLERS: Readonly<Record<string, IProviderHandler>> = Object.freeze({
  codex: codexHandler,
  "google-gemini": googleGeminiHandler,
  "xai-grok": xaiGrokHandler,
});

export async function loadManifests(): Promise<ProviderManifest[]> {
  const manifests: ProviderManifest[] = [];

  try {
    const files = await readdir(MANIFESTS_DIR);
    for (const file of files) {
      const ext = extname(file);
      if (ext !== ".yaml" && ext !== ".yml") continue;

      const content = await readFile(join(MANIFESTS_DIR, file), "utf-8");
      const manifest = parseYaml(content) as ProviderManifest;

      if (!manifest.id || !manifest.name || !manifest.baseUrl) {
        console.warn(`[manifests] Skipping invalid manifest: ${file}`);
        continue;
      }

      manifests.push(manifest);
    }
  } catch (err) {
    console.warn(`[manifests] Could not read manifests directory: ${err}`);
  }

  console.log(`[manifests] Loaded ${manifests.length} provider manifests`);
  return manifests;
}

const handlerCache = new Map<string, IProviderHandler>();

export async function loadHandler(handlerId: string): Promise<IProviderHandler | null> {
  if (handlerCache.has(handlerId)) {
    return handlerCache.get(handlerId)!;
  }

  const bundledHandler = BUNDLED_HANDLERS[handlerId];
  if (bundledHandler) {
    handlerCache.set(handlerId, bundledHandler);
    console.log(`[manifests] Loaded bundled handler: ${handlerId}`);
    return bundledHandler;
  }

  // Preserve standalone Pointer's extension point for operator-supplied
  // handlers while keeping repository-owned handlers inside the server bundle.
  const handlerPath = join(HANDLERS_DIR, `${handlerId}.ts`);
  try {
    const module = await import(handlerPath);
    const handler: IProviderHandler = module.default || module;
    handlerCache.set(handlerId, handler);
    console.log(`[manifests] Loaded handler: ${handlerId}`);
    return handler;
  } catch (err) {
    console.warn(`[manifests] Could not load handler ${handlerId}: ${err}`);
    return null;
  }
}
