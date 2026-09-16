const PROVIDER_PREFIXES = [
  "openai/", "anthropic/", "meta-llama/", "google/", "mistralai/", "cohere/", "deepseek/", "deepseek-ai/",
  "qwen/", "microsoft/", "x-ai/", "nvidia/", "amazon/", "ai21/", "perplexity/", "nousresearch/", "01-ai/",
  "databricks/", "moonshotai/", "all-hands/", "arcee-ai/", "baidu/", "alibaba/", "z-ai/", "bytedance-seed/",
  "bytedance/", "minimax/", "rekaai/", "tencent/", "inclusionai/", "openrouter/", "poolside/", "writer/",
];

export const MANUAL_MODEL_ALIASES: Record<string, string> = {
  "gemini-1-5-pro": "google/gemini-pro-1.5",
  "gemini-1-5-flash": "google/gemini-flash-1.5",
  "gemini-2-0-flash": "google/gemini-2.0-flash-001",
  "gemini-2-0-flash-lite": "google/gemini-2.0-flash-lite-001",
  "gemini-3-flash": "google/gemini-3-flash-preview",
  "gemini-3-pro": "google/gemini-3.1-pro-preview-customtools",
  "gemini-3-1-pro": "google/gemini-3.1-pro-preview-customtools",
  "deepseek-v3": "deepseek/deepseek-chat",
  "deepseek-v3-0324": "deepseek/deepseek-chat-v3-0324",
  "deepseek-v3-1": "deepseek/deepseek-chat-v3.1",
  "deepseek-coder-v2": "deepseek/deepseek-coder",
  "mistral-large-3": "mistralai/mistral-large-2512",
  "mistral-medium": "mistralai/mistral-medium-3",
  "qwen2-5-max": "qwen/qwen-max",
  "minimax-m2": "minimax/minimax-m2-her",
  "glm-5": "z-ai/glm-5-turbo",
  "glm-4-5": "z-ai/glm-4.5-air:free",
};

function normalizeBase(raw: string): string {
  let value = raw.toLowerCase().trim();
  value = value.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  value = value.replace(/\s*\+\s*.+$/, "").replace(/,\s*(no think|alibaba api|diff).*$/i, "");
  for (const prefix of PROVIDER_PREFIXES) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }
  value = value.replace(/^(amazon|meta|google|openai|anthropic|mistralai|cohere|deepseek|qwen|microsoft|nvidia)\./i, "");
  value = value.replace(/^[a-z0-9_-]+:\s+/, "").replace(/:[a-z0-9]+$/, "");
  return value.replace(/[_\s.]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export const normalizeModelLight = (raw: string) => normalizeBase(raw);

export function normalizeModelAggressive(raw: string): string {
  let value = normalizeBase(raw);
  for (let index = 0; index < 5; index += 1) {
    const before = value;
    value = value.replace(/-(instruct|chat|hf|it|thinking|no-thinking|preview|quality|base|exp|experimental)$/, "");
    value = value.replace(/-(fast|high|low|instant|medium|reasoning|non-reasoning)$/, "");
    value = value.replace(/-\d+k$/, "").replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
    value = value.replace(/-\d{4}$/, "").replace(/-preview-\d{2}-\d{2}$/, "-preview");
    value = value.replace(/-v?\d+-\d+$/, "").replace(/-0\d{2}$/, "").replace(/-(bf16|fp8|fp16|int8|turbo)$/, "");
    if (value === before) break;
  }
  return value.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export interface CanonicalIdentity {
  id: string;
  name: string;
  aliases?: string[];
}

export interface MatchIndex {
  light: Map<string, Set<string>>;
  aggressive: Map<string, Set<string>>;
  identities: Map<string, CanonicalIdentity>;
}

function add(index: Map<string, Set<string>>, alias: string, id: string) {
  const ids = index.get(alias) ?? new Set<string>();
  ids.add(id);
  index.set(alias, ids);
}

export function buildModelMatchIndex(identities: CanonicalIdentity[]): MatchIndex {
  const index: MatchIndex = { light: new Map(), aggressive: new Map(), identities: new Map() };
  for (const identity of identities) {
    index.identities.set(identity.id, identity);
    const slash = identity.id.indexOf("/");
    const candidates = [identity.id, slash >= 0 ? identity.id.slice(slash + 1) : identity.id, identity.name, ...(identity.aliases ?? [])];
    for (const candidate of candidates) {
      add(index.light, normalizeModelLight(candidate), identity.id);
      add(index.aggressive, normalizeModelAggressive(candidate), identity.id);
    }
  }
  for (const [alias, id] of Object.entries(MANUAL_MODEL_ALIASES)) {
    if (!index.identities.has(id)) continue;
    add(index.light, normalizeModelLight(alias), id);
    add(index.aggressive, normalizeModelAggressive(alias), id);
  }
  return index;
}

export type ModelMatch =
  | { status: "matched"; canonicalId: string; strategy: "light" | "aggressive" | "manual" }
  | { status: "ambiguous"; candidates: string[]; normalized: string }
  | { status: "unmatched"; normalized: string };

export function matchCanonicalModel(raw: string, index: MatchIndex): ModelMatch {
  const manual = MANUAL_MODEL_ALIASES[normalizeModelLight(raw)];
  if (manual && index.identities.has(manual)) return { status: "matched", canonicalId: manual, strategy: "manual" };
  for (const [strategy, normalized, lookup] of [
    ["light", normalizeModelLight(raw), index.light],
    ["aggressive", normalizeModelAggressive(raw), index.aggressive],
  ] as const) {
    const candidates = [...(lookup.get(normalized) ?? [])].sort();
    if (candidates.length === 1) return { status: "matched", canonicalId: candidates[0], strategy };
    if (candidates.length > 1) return { status: "ambiguous", candidates, normalized };
  }
  return { status: "unmatched", normalized: normalizeModelAggressive(raw) };
}

const ACRONYMS = new Set(["gpt", "ai", "llm", "vl", "xl", "xxl", "api", "r1"]);

export function friendlyModelName(raw: string): string {
  const slug = raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw;
  return slug.replace(/:[a-z0-9_-]+$/i, "").split(/[-_.\s]+/).filter(Boolean).map((part) => {
    if (ACRONYMS.has(part.toLowerCase())) return part.toUpperCase();
    if (/^v\d/i.test(part)) return part.toUpperCase();
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(" ");
}

export const MODEL_FIELD_PRECEDENCE = Object.freeze({
  name: ["openrouter", "provider", "benchmark", "fallback"],
  creator: ["openrouter", "provider", "inference"],
  description: ["openrouter", "provider"],
  capabilities: ["provider", "openrouter"],
  contextWindow: ["provider", "openrouter"],
  maxOutput: ["provider", "openrouter"],
  referencePricing: ["openrouter"],
  providerPricing: ["provider"],
});
