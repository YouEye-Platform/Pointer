import { describe, expect, test } from "bun:test";
import { OpenRouterAdapter } from "./openrouter";
import { SourceFetchError, type FetchLike } from "./types";

const adapter = new OpenRouterAdapter();
const fixedNow = () => new Date("2026-07-10T00:00:00.000Z");
const jsonResponse = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);

describe("OpenRouterAdapter", () => {
  test("normalizes text models, pricing, and provenance", async () => {
    const fetchImpl = async () => jsonResponse({ data: [{
      id: "vendor/model-a",
      name: "Model A",
      created: 1783641600,
      context_length: 128000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0.000002", completion: "0.000008" },
      supported_parameters: ["tools"],
    }] });
    const snapshot = await adapter.fetch({ fetchImpl: fetchImpl as FetchLike, now: fixedNow });
    expect(snapshot.records[0].inputPricePerMillion).toBe(2);
    expect(snapshot.records[0].outputPricePerMillion).toBe(8);
    expect(snapshot.records[0].creator).toBe("vendor");
    expect(snapshot.records[0].releasedAt).toBe("2026-07-10T00:00:00.000Z");
    expect(snapshot.records[0].provenance.license).toContain("Public API");
    expect(snapshot.provenance.fetchedAt).toBe("2026-07-10T00:00:00.000Z");
  });

  test("rejects an empty snapshot", async () => {
    const fetchImpl = async () => jsonResponse({ data: [] });
    await expect(adapter.fetch({ fetchImpl: fetchImpl as FetchLike })).rejects.toMatchObject({ code: "empty" });
  });

  test("rejects malformed source data", async () => {
    const fetchImpl = async () => new Response("not-json");
    await expect(adapter.fetch({ fetchImpl: fetchImpl as FetchLike })).rejects.toMatchObject({ code: "malformed" });
  });

  test("rejects oversized payloads before reading the body", async () => {
    const fetchImpl = async () => new Response("{}", { headers: { "content-length": String(adapter.maxBytes + 1) } });
    await expect(adapter.fetch({ fetchImpl: fetchImpl as FetchLike })).rejects.toMatchObject({ code: "oversized" });
  });

  test("reports upstream errors", async () => {
    const fetchImpl = async () => new Response("unavailable", { status: 503 });
    await expect(adapter.fetch({ fetchImpl: fetchImpl as FetchLike })).rejects.toMatchObject({ code: "upstream", status: 503 });
  });

  test("reports timeout errors", async () => {
    const fetchImpl = (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const originalTimeout = adapter.timeoutMs;
    Object.defineProperty(adapter, "timeoutMs", { value: 1, configurable: true });
    try {
      await expect(adapter.fetch({ fetchImpl: fetchImpl as FetchLike })).rejects.toBeInstanceOf(SourceFetchError);
      await expect(adapter.fetch({ fetchImpl: fetchImpl as FetchLike })).rejects.toMatchObject({ code: "timeout" });
    } finally {
      Object.defineProperty(adapter, "timeoutMs", { value: originalTimeout, configurable: true });
    }
  });
});
