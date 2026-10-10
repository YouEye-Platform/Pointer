import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { isAllowedEndpointAddress, validateProviderEndpoint } from "./custom-endpoint";
import type { PointerFetch } from "../http-runtime";

/** Pin the validated DNS result to this connection while verifying TLS against
 * the original hostname. Redirects never carry an account's credentials onward. */
export const fetchCustomProviderEndpoint: PointerFetch = async (input, init = {}) => {
  if (input instanceof Request) throw new Error("Custom endpoint requires an explicit URL");
  const url = new URL(input.toString());
  await validateProviderEndpoint(`${url.origin}${url.pathname}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(x=>!isAllowedEndpointAddress(x.address))) throw new Error("Endpoint destination is not allowed");
  const address = addresses[0]!;
  if (init.body !== undefined && init.body !== null && typeof init.body !== "string") throw new Error("Unsupported custom endpoint request body");
  return new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) { reject(init.signal.reason); return; }
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: init.method ?? "GET", headers, agent: false,
      ...(url.protocol === "https:" ? { servername: host, rejectUnauthorized: true } : {}),
      lookup: (_host, options, callback) => {
        if ((options as { all?: boolean }).all) {
          (callback as unknown as (error: null, values: { address: string; family: number }[]) => void)(null, [address]);
        } else callback(null, address.address, address.family);
      },
    }, res => {
      const status = res.statusCode ?? 502;
      if (status >= 300 && status < 400) { res.destroy(); reject(new Error("Provider redirects are not allowed")); return; }
      const responseHeaders = new Headers();
      for (const [name,value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
      const body = status === 204 || status === 205 || init.method === "HEAD" ? null : Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status, headers: responseHeaders }));
      res.once("close",()=>init.signal?.removeEventListener("abort", abort));
    });
    const abort = () => req.destroy(init.signal?.reason instanceof Error ? init.signal.reason : new Error("Request cancelled"));
    init.signal?.addEventListener("abort", abort, { once: true });
    req.once("error", error=>{ init.signal?.removeEventListener("abort", abort); reject(error); });
    req.end(init.body ?? undefined);
  });
};
