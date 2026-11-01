import { api } from "./api";
import { accountConnection } from "./provider-state";

export type Preset = { id: string; label: string; adapter: string; baseUrl: string; auth: string;
  oauthProvider?: string; keyOptional?: boolean; dashboardUrl?: string; provider?: Record<string, unknown>;
  responsesPath?: string; chatCompletionsPath?: string; defaultModel?: string;
  baseUrlChoices?: Array<{ id: string; label: string; baseUrl?: string }> };
type Provider = { name: string; adapter: string; baseUrl: string; hasApiKey: boolean; hasHeaders?: boolean; authMode?: string; disabled: boolean; connection?: { setup: boolean; label: string } };
type Model = { provider: string; id: string; namespaced: string; displayName?: string; displayNameSource?: string };

export type Inventory = { providers: Provider[]; presets: Preset[]; oauth: string[]; models: Model[] };

export async function inventory(): Promise<Inventory> {
  const [providers, choices, oauth, models] = await Promise.all([
    api.get<Provider[]>("/api/connections/providers"),
    api.get<{ providers: Preset[] }>("/api/connections/provider-presets"),
    api.get<{ providers: string[] }>("/api/connections/oauth/providers"),
    api.get<Model[]>("/api/connections/models"),
  ]);
  const presets = [...choices.providers];
  for (const id of oauth.providers) if (!presets.some(row => row.oauthProvider === id))
    presets.push({ id, label: id, adapter: "", baseUrl: "", auth: "oauth", oauthProvider: id });
  for (const provider of providers) if (!presets.some(row => row.id === provider.name || row.oauthProvider === provider.name))
    presets.push({ id: provider.name, label: provider.name, adapter: provider.adapter, baseUrl: provider.baseUrl, auth: "key" });
  await Promise.all(providers.map(async provider => {
    const preset = presets.find(row => (row.oauthProvider || row.id) === provider.name);
    if (preset?.auth === "forward" || preset?.auth === "oauth") {
      try {
        const path = preset.auth === "forward" ? "/api/connections/codex-auth/accounts"
          : `/api/connections/oauth/accounts?provider=${encodeURIComponent(provider.name)}`;
        const result = await api.get<{ accounts?: Parameters<typeof accountConnection>[0] }>(path);
        provider.connection = accountConnection(result.accounts ?? []);
      } catch { provider.connection = { setup: true, label: "Connection status unavailable" }; }
    } else {
      const setup = Boolean(provider.hasApiKey || provider.hasHeaders || provider.authMode === "none" || preset?.auth === "local" || preset?.keyOptional);
      provider.connection = { setup, label: setup ? "Connected" : "Key required" };
    }
    if (provider.disabled) provider.connection = { ...provider.connection, label: "Disabled" };
  }));
  return { providers, presets, oauth: oauth.providers, models };
}
