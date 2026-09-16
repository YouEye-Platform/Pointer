"use client";

import Image from "next/image";
import { useState } from "react";

const BRAND_ICONS: Record<string, string> = {
  "01-ai": "yi-color.svg",
  "01ai": "yi-color.svg",
  ai21: "ai21-brand-color.svg",
  alibaba: "qwen-color.svg",
  anthropic: "anthropic.svg",
  arcee: "arcee-color.svg",
  aws: "aws-color.svg",
  aya: "aya-color.svg",
  baidu: "baidu-color.svg",
  cerebras: "cerebras-color.svg",
  chatglm: "chatglm-color.svg",
  claude: "claude-color.svg",
  codex: "codex-color.svg",
  cohere: "cohere-color.svg",
  command: "commanda-color.svg",
  commanda: "commanda-color.svg",
  deepinfra: "deepinfra-color.svg",
  deepseek: "deepseek-color.svg",
  fireworks: "fireworks-color.svg",
  gemini: "gemini-color.svg",
  "google-gemini": "gemini-color.svg",
  gemma: "gemma-color.svg",
  google: "google-color.svg",
  grok: "grok.svg",
  groq: "groq.svg",
  kimi: "kimi.svg",
  meta: "meta-color.svg",
  "meta-llama": "meta-color.svg",
  microsoft: "microsoft-color.svg",
  minimax: "minimax-color.svg",
  mistral: "mistral-color.svg",
  mistralai: "mistral-color.svg",
  moonshot: "kimi.svg",
  "moonshot-ai": "kimi.svg",
  nvidia: "nvidia-color.svg",
  openai: "openai.svg",
  "openai-codex": "openai.svg",
  openrouter: "openrouter-color.svg",
  perplexity: "perplexity-color.svg",
  qwen: "qwen-color.svg",
  sambanova: "sambanova-color.svg",
  together: "together-color.svg",
  upstage: "upstage-color.svg",
  xai: "xai.svg",
  "xai-grok": "grok.svg",
  "x-ai": "xai.svg",
  yi: "yi-color.svg",
  zai: "zhipu-color.svg",
  "z-ai": "zhipu-color.svg",
  zhipu: "zhipu-color.svg",
  zhipuai: "zhipu-color.svg",
};

export function IconAvatar({ iconKey, name, size = 28 }: { iconKey?: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const normalized = iconKey?.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "";
  const file = BRAND_ICONS[normalized];
  const branded = Boolean(file && !failed);

  return (
    <span
      className="icon-avatar"
      data-icon-kind={branded ? "brand" : "generic"}
      data-icon-key={branded ? normalized : undefined}
      style={{ width: size, height: size }}
      aria-label={name}
      title={name}
    >
      {branded ? (
        <Image
          src={`/icons/brands/${file}`}
          alt=""
          width={size}
          height={size}
          unoptimized
          onError={() => setFailed(true)}
        />
      ) : (
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l1.3 4.2a5 5 0 003.3 3.3L21 12l-4.4 1.5a5 5 0 00-3.2 3.2L12 21l-1.4-4.3a5 5 0 00-3.2-3.2L3 12l4.4-1.5a5 5 0 003.3-3.3L12 3z" />
        </svg>
      )}
    </span>
  );
}
