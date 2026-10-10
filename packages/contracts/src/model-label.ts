/** Presentation only: never use a formatted label as an upstream model selector. */
export function modelLabel(model: { id: string; namespaced?: string; displayName?: string; displayNameSource?: string }) {
  const supplied = model.displayName?.trim();
  if (supplied && model.displayNameSource !== "fallback" && supplied !== model.id && supplied !== model.namespaced)
    return supplied;
  const local = model.id.slice(model.id.lastIndexOf("/") + 1);
  // Format known family spellings, not model identity, versions or capabilities.
  // Unknown/custom IDs retain their exact spelling until a provider names them.
  const match = /^(gpt|glm|deepseek|kimi|grok|qwen|mimo|minimax|muse|claude|gemini|llama)(?=[-\d])(.+)$/i.exec(local);
  if (!match) return model.id;
  const family: Record<string, string> = { gpt: "GPT", glm: "GLM", deepseek: "DeepSeek", kimi: "Kimi", grok: "Grok", qwen: "Qwen", mimo: "MiMo", minimax: "MiniMax", muse: "Muse", claude: "Claude", gemini: "Gemini", llama: "Llama" };
  const rest = match[2]!.replace(/^-/, "").split("-").map(token => token.charAt(0).toUpperCase() + token.slice(1)).join(" ");
  return `${family[match[1]!.toLowerCase()]}${/^(gpt|glm)$/i.test(match[1]!) ? "-" : " "}${rest}`;
}
