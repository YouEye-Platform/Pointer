import type { Context } from "hono";

export type PlatformErrorBody = {
  error: {
    status: number;
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
};

export function requestIdFor(c: Context): string {
  const current = c.get("requestId" as never) as string | undefined;
  return current || "unknown";
}

export function platformError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 500 | 503,
  code: string,
  message: string,
  options: {
    retryable?: boolean;
    details?: Record<string, unknown>;
  } = {}
) {
  const body: PlatformErrorBody = {
    error: {
      status,
      code,
      message,
      requestId: requestIdFor(c),
      retryable: options.retryable ?? false,
      ...(options.details ? { details: options.details } : {}),
    },
  };
  return c.json(body, status);
}
