import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  allowLongLivedStream,
  createBunFetchHandler,
  fetchWithClientAbort,
  UpstreamTransportError,
  type PointerRuntimeBindings,
} from "./http-runtime";

const servers: Array<Bun.Server<unknown>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function serveQuietFixture(onCancel?: () => void) {
  const app = new Hono<{ Bindings: PointerRuntimeBindings }>();
  app.post("/v1/quiet", async (c) => {
    const body = await c.req.json<{ stream?: unknown }>();
    allowLongLivedStream(c.env, c.req.raw, body.stream);

    let cancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("start\n"));
        setTimeout(() => {
          if (cancelled) return;
          controller.enqueue(encoder.encode("end\n"));
          controller.close();
        }, 5_000);
      },
      cancel() {
        cancelled = true;
        onCancel?.();
      },
    });
    return new Response(responseBody, {
      headers: { "content-type": "text/event-stream" },
    });
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 2,
    fetch: createBunFetchHandler(app),
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/v1/quiet`;
}

async function runExternalClient(url: string, source: string): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", source], {
    env: { ...process.env, POINTER_RUNTIME_TEST_URL: url },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return child.exited;
}

describe("Bun request timeout integration", () => {
  test("disables the idle timeout only for validated streaming requests", () => {
    const calls: Array<{ request: Request; seconds: number }> = [];
    const request = new Request("http://pointer.test/v1/messages");
    const bindings: PointerRuntimeBindings = {
      requestTimeout: {
        timeout(observedRequest, seconds) {
          calls.push({ request: observedRequest, seconds });
        },
      },
    };

    expect(allowLongLivedStream(bindings, request, false)).toBe(false);
    expect(allowLongLivedStream(bindings, request, "true")).toBe(false);
    expect(calls).toEqual([]);
    expect(allowLongLivedStream(bindings, request, true)).toBe(true);
    expect(calls).toEqual([{ request, seconds: 0 }]);
  });

  test("allows a downstream stream to remain quiet beyond Bun's idle timeout", async () => {
    const url = serveQuietFixture();
    const exitCode = await runExternalClient(url, `
      const response = await fetch(process.env.POINTER_RUNTIME_TEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: true }),
      });
      const body = await response.text();
      if (body !== "start\\nend\\n") process.exit(2);
    `);
    expect(exitCode).toBe(0);
  }, 12_000);

  test("retains the idle timeout for non-streaming requests", async () => {
    const url = serveQuietFixture();
    const exitCode = await runExternalClient(url, `
      try {
        const response = await fetch(process.env.POINTER_RUNTIME_TEST_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stream: false }),
        });
        await response.text();
        process.exit(2);
      } catch {
        process.exit(0);
      }
    `);
    expect(exitCode).toBe(0);
  }, 12_000);

  test("still propagates client cancellation to the response stream", async () => {
    let resolveCancelled: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    const url = serveQuietFixture(() => resolveCancelled?.());
    const exitCode = await runExternalClient(url, `
      const controller = new AbortController();
      const response = await fetch(process.env.POINTER_RUNTIME_TEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: true }),
        signal: controller.signal,
      });
      const reader = response.body.getReader();
      await reader.read();
      controller.abort();
      try { await reader.read(); } catch {}
    `);
    expect(exitCode).toBe(0);
    await expect(
      Promise.race([
        cancelled.then(() => true),
        Bun.sleep(2_000).then(() => false),
      ]),
    ).resolves.toBe(true);
  }, 8_000);

  test("aborts an upstream fetch while response headers are still pending", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const pending = fetchWithClientAbort(
      "http://provider.test/v1/messages",
      { method: "POST" },
      controller.signal,
      async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      },
    );

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignal?.aborted).toBe(true);
  });

  test("distinguishes provider transport failures from downstream cancellation", async () => {
    const client = new AbortController();
    const connectionFailure = fetchWithClientAbort(
      "http://provider.test/v1/messages",
      { method: "POST" },
      client.signal,
      async () => {
        throw new TypeError("sensitive provider connection detail");
      },
    );
    await expect(connectionFailure).rejects.toBeInstanceOf(UpstreamTransportError);
    await expect(connectionFailure).rejects.toMatchObject({
      name: "UpstreamTransportError",
      message: "Provider transport failed",
      timeout: false,
    });

    const timeout = fetchWithClientAbort(
      "http://provider.test/v1/messages",
      { method: "POST" },
      client.signal,
      async () => {
        throw new DOMException("sensitive timeout detail", "TimeoutError");
      },
    );
    await expect(timeout).rejects.toMatchObject({
      name: "UpstreamTransportError",
      message: "Provider transport timed out",
      timeout: true,
    });
  });
});
