export const POSITIONAL_MODEL_ALIASES = [
  ["big", "opus", "default"],
  ["medium", "sonnet", "secondary"],
  ["small", "haiku", "utility"],
] as const;

export const RESERVED_MODEL_ALIASES = new Set<string>(POSITIONAL_MODEL_ALIASES.flat());

export function normalizeModelLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeManualModelAlias(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  return normalized || null;
}

export function isReservedModelAlias(value: string | null | undefined): boolean {
  const normalized = normalizeManualModelAlias(value);
  return normalized != null && RESERVED_MODEL_ALIASES.has(normalizeModelLookupKey(normalized));
}

export function reservedModelAliasMessage(): string {
  return `Alias is reserved for positional routing: ${[...RESERVED_MODEL_ALIASES].join(", ")}`;
}
