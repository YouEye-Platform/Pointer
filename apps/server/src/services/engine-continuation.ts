import { createHmac, timingSafeEqual } from "node:crypto";

/** Continuation handles remain usable after key rotation, within one instance. */
export class ContinuationScope {
  constructor(private secret: string, private owner: string, private instance: string) {
    if (!secret || !owner || !instance) throw new Error("Continuation scope requires identity and a secret");
  }

  private sign(value: string) {
    return createHmac("sha256", this.secret).update(JSON.stringify([
      "pointer.response", this.owner, this.instance, value,
    ])).digest("base64url");
  }

  encode(value: string): string {
    const encoded = Buffer.from(value).toString("base64url");
    return `resp_ptr_${encoded}.${this.sign(encoded)}`;
  }

  decode(value: unknown): string {
    if (typeof value !== "string" || value.length > 4096) throw new Error("Invalid continuation handle");
    const match = /^resp_ptr_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!match || !timingSafeEqual(Buffer.from(match[2]!), Buffer.from(this.sign(match[1]!))))
      throw new Error("Invalid continuation handle");
    return Buffer.from(match[1]!, "base64url").toString("utf8");
  }

  project(value: Record<string, unknown>): Record<string, unknown> {
    const result = { ...value };
    if (value.object === "response" && typeof value.id === "string") result.id = this.encode(value.id);
    if (typeof value.response_id === "string") result.response_id = this.encode(value.response_id);
    if (typeof value.previous_response_id === "string") result.previous_response_id = this.encode(value.previous_response_id);
    if (value.response && typeof value.response === "object" && !Array.isArray(value.response))
      result.response = this.project(value.response as Record<string, unknown>);
    return result;
  }

  cacheKey(value: string): string { return this.sign("cache:" + value); }

  /** Forward only protocol metadata and a private instance-scoped conversation. */
  requestHeaders(source: Headers, requestId: string): Headers {
    const headers = new Headers();
    for (const name of ["content-type", "accept", "anthropic-version", "anthropic-beta"])
      if (source.has(name)) headers.set(name, source.get(name)!);
    const conversation = ["x-opencode-session", "session_id", "session-id", "thread-id", "x-claude-code-session-id", "x-session-id"]
      .map(name => source.get(name))
      .find(value => value && /^[A-Za-z0-9_.:-]{1,300}$/.test(value));
    const identity = "ptr_session_" + this.sign("conversation:" + (conversation ?? requestId));
    headers.set("x-opencode-session", identity);
    headers.set("session_id", identity);
    return headers;
  }
}
