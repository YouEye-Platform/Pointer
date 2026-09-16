interface ProviderIdentity {
  id: string;
  manifestPath?: string | null;
}

interface ModelIdentity {
  id: string;
  name: string;
  creator?: string | null;
}

const PROVIDER_ALIASES: Record<string, string> = {
  "google-gemini": "gemini",
  "openai-codex": "openai",
  "xai-grok": "grok",
  "x-ai": "xai",
  zai: "zhipu",
  "z-ai": "zhipu",
};

const CREATOR_ALIASES: Record<string, string> = {
  "01-ai": "yi",
  "01ai": "yi",
  ai21: "ai21",
  "ai21-labs": "ai21",
  alibaba: "qwen",
  anthropic: "anthropic",
  arcee: "arcee",
  aws: "aws",
  amazon: "aws",
  baidu: "baidu",
  cerebras: "cerebras",
  cohere: "cohere",
  deepseek: "deepseek",
  google: "google",
  meta: "meta",
  microsoft: "microsoft",
  minimax: "minimax",
  mistral: "mistral",
  "mistral-ai": "mistral",
  moonshot: "kimi",
  "moonshot-ai": "kimi",
  nvidia: "nvidia",
  openai: "openai",
  perplexity: "perplexity",
  upstage: "upstage",
  xai: "xai",
  "x-ai": "xai",
  zhipu: "zhipu",
  zhipuai: "zhipu",
  zai: "zhipu",
  "z-ai": "zhipu",
};

const slug = (value: string) => value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

const identityWords = (...values: Array<string | null | undefined>) => ` ${values
  .filter((value): value is string => Boolean(value))
  .join(" ")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")} `;

const hasWord = (identity: string, value: string) => identity.includes(` ${value} `);
const hasAnyWord = (identity: string, values: string[]) => values.some((value) => hasWord(identity, value));

export function resolveProviderIconKey(provider: ProviderIdentity): string {
  const manifest = provider.manifestPath
    ?.replace(/^providers\.d\//, "")
    .replace(/\.ya?ml$/, "");
  const candidate = slug(manifest || provider.id.replace(/-[A-Za-z0-9_-]{6}$/, ""));
  return PROVIDER_ALIASES[candidate] ?? candidate;
}

export function resolveModelIconKey(model: ModelIdentity): string | null {
  const identity = identityWords(model.id, model.name);

  if (hasWord(identity, "claude")) return "claude";
  if (hasWord(identity, "codex")) return "codex";
  if (hasWord(identity, "deepseek")) return "deepseek";
  if (hasWord(identity, "gemini")) return "gemini";
  if (hasWord(identity, "gemma")) return "gemma";
  if (hasWord(identity, "grok")) return "grok";
  if (hasWord(identity, "llama")) return "meta";
  if (hasWord(identity, "qwen")) return "qwen";
  if (hasAnyWord(identity, ["kimi", "moonshot"])) return "kimi";
  if (hasAnyWord(identity, ["mistral", "mixtral", "codestral", "ministral", "magistral"])) return "mistral";
  if (hasWord(identity, "aya")) return "aya";
  if (hasWord(identity, "command")) return "commanda";
  if (hasWord(identity, "jamba")) return "ai21";
  if (hasAnyWord(identity, ["chatglm", "glm"])) return "chatglm";
  if (hasWord(identity, "phi")) return "microsoft";
  if (hasWord(identity, "nemotron")) return "nvidia";
  if (hasAnyWord(identity, ["perplexity", "sonar"])) return "perplexity";
  if (hasWord(identity, "yi")) return "yi";
  if (hasWord(identity, "ernie")) return "baidu";
  if (hasAnyWord(identity, ["gpt", "chatgpt", "o1", "o3", "o4"])) return "openai";

  const creator = slug(model.creator ?? "");
  return CREATOR_ALIASES[creator] ?? null;
}
