import { expect, test } from "bun:test";
import { fetchCustomProviderEndpoint } from "./endpoint-fetch";

test("local HTTP transport pins an allowed destination and never follows credential-bearing redirects", async () => {
  const previous = process.env.POINTER_ALLOW_LOCAL_ENDPOINTS;
  process.env.POINTER_ALLOW_LOCAL_ENDPOINTS = "true";
  let redirected = 0;
  const destination = Bun.serve({hostname:"127.0.0.1",port:0,fetch(){ redirected++; return Response.json({ok:true}); }});
  const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){
    if (new URL(req.url).pathname === "/redirect") return Response.redirect(destination.url,302);
    return Response.json({received: req.headers.get("authorization") === "Bearer synthetic-fixture"});
  }});
  try {
    const result = await fetchCustomProviderEndpoint(server.url,{headers:{authorization:"Bearer synthetic-fixture"}});
    expect(await result.json()).toEqual({received:true});
    await expect(fetchCustomProviderEndpoint(new URL("redirect",server.url),{headers:{authorization:"Bearer synthetic-fixture"}})).rejects.toThrow("redirects");
    expect(redirected).toBe(0);
    const abort = new AbortController(); abort.abort(new Error("fixture cancellation"));
    await expect(fetchCustomProviderEndpoint(server.url,{signal:abort.signal})).rejects.toThrow("fixture cancellation");
    process.env.POINTER_ALLOW_LOCAL_ENDPOINTS = "false";
    await expect(fetchCustomProviderEndpoint(server.url)).rejects.toThrow();
  } finally { server.stop(true); destination.stop(true); if (previous === undefined) delete process.env.POINTER_ALLOW_LOCAL_ENDPOINTS; else process.env.POINTER_ALLOW_LOCAL_ENDPOINTS = previous; }
});
