/** Client content cannot override the group route selected by Pointer. */
export function engineRequestBoundaryError(path: string, body: Record<string, unknown>): string | null {
  if (path.startsWith("/messages")) {
    const system = typeof body.system === "string" ? body.system : Array.isArray(body.system)
      ? body.system.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
    if (/<!--\s*ocx-route:\s*([^\s]+)\s*-->/.test(system))
      return "Select the model through this instance's model name; embedded route overrides are unavailable";
  }
  if (path.startsWith("/responses")) {
    if (body.conversation != null || body.stream_id != null)
      return "Use this instance's previous_response_id for stored conversation continuation";
    if (Array.isArray(body.input) && body.input.some(item => item?.type === "item_reference"))
      return "Stored item references are unavailable; supply the input content or previous_response_id";
  }
  return null;
}

/** The public Responses string shorthand is a single user message. Codex's
 * native backend requires the equivalent list even when other engines accept it. */
export function normalizeEngineInput(path: string, body: Record<string, unknown>): void {
  if (path === "/responses" && typeof body.input === "string")
    body.input = [{ role: "user", content: [{ type: "input_text", text: body.input }] }];
}
