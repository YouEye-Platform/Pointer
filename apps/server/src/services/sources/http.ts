import { SourceFetchError } from "./types";
import type { FetchLike } from "./types";

const USER_AGENT = "Pointer/0.1 (+https://github.com/YouEye-Platform/Pointer)";

export async function fetchBoundedBytes(
  url: string,
  options: {
    timeoutMs: number;
    maxBytes: number;
    fetchImpl?: FetchLike;
    headers?: Record<string, string>;
  }
): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...options.headers },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new SourceFetchError(`Source request timed out after ${options.timeoutMs}ms`, "timeout");
      }
      throw error;
    }

    if (!response.ok) {
      throw new SourceFetchError(`Source returned HTTP ${response.status}`, "upstream", response.status);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
      throw new SourceFetchError(`Source payload exceeds ${options.maxBytes} bytes`, "oversized");
    }

    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel();
        throw new SourceFetchError(`Source payload exceeds ${options.maxBytes} bytes`, "oversized");
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchBoundedJson(
  url: string,
  options: Parameters<typeof fetchBoundedBytes>[1]
): Promise<unknown> {
  const bytes = await fetchBoundedBytes(url, options);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SourceFetchError("Source returned malformed JSON", "malformed");
  }
}
