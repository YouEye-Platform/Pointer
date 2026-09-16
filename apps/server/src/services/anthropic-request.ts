export function sanitizeAnthropicRequestBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const {
    "anthropic-version": _anthropicVersion,
    ...clean
  } = body;
  return clean;
}
