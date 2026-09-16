export interface RequestTimeoutController {
  timeout(request: Request, seconds: number): void;
}

export interface PointerRuntimeBindings {
  requestTimeout?: RequestTimeoutController;
}

export type PointerFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** A provider connection failed before an HTTP response was available. */
export class UpstreamTransportError extends Error {
  readonly timeout: boolean;

  constructor(timeout: boolean) {
    super(timeout ? "Provider transport timed out" : "Provider transport failed");
    this.name = "UpstreamTransportError";
    this.timeout = timeout;
  }
}

interface PointerFetchApplication {
  fetch(
    request: Request,
    bindings?: PointerRuntimeBindings,
  ): Response | Promise<Response>;
}

/** Pass Bun's per-request timeout control through to the Hono request context. */
export function createBunFetchHandler(app: PointerFetchApplication) {
  return (request: Request, server: Bun.Server<unknown>) =>
    app.fetch(request, { requestTimeout: server });
}

/**
 * Streaming inference responses are intentionally long-lived. Disable Bun's
 * request idle timeout only after the public request has passed validation.
 */
export function allowLongLivedStream(
  bindings: PointerRuntimeBindings | undefined,
  request: Request,
  stream: unknown,
): boolean {
  if (stream !== true || !bindings?.requestTimeout) return false;
  bindings.requestTimeout.timeout(request, 0);
  return true;
}

/** Keep the provider request tied to the lifetime of its downstream client. */
export async function fetchWithClientAbort(
  input: string | URL | Request,
  init: RequestInit,
  clientSignal: AbortSignal,
  fetchImpl: PointerFetch = fetch,
): Promise<Response> {
  const signal = init.signal && init.signal !== clientSignal
    ? AbortSignal.any([init.signal, clientSignal])
    : clientSignal;
  try {
    return await fetchImpl(input, { ...init, signal });
  } catch (error) {
    // Preserve downstream cancellation so the proxy can record a client abort
    // instead of misclassifying it as a provider outage.
    if (clientSignal.aborted) throw error;
    const timeout = error instanceof Error
      && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new UpstreamTransportError(timeout);
  }
}
