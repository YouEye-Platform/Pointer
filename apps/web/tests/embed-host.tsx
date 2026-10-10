import * as React from "react";
import { createRoot } from "react-dom/client";

function HostCounter() {
  const [count, setCount] = React.useState(0);
  return <button id="host-counter" onClick={() => setCount(count + 1)}>Host count {count}</button>;
}
createRoot(document.getElementById("host")!).render(<HostCounter />);
const manifest = await fetch("/pointer-ui/manifest.json").then(response => response.json());
const { createPointerUI } = await import(/* webpackIgnore: true */ "/pointer-ui/" + manifest.entry);
const requests: string[] = [];
(window as any).fixtureRequests = requests;
const mount = (id: string) => createPointerUI({ React, createRoot }).mount(document.getElementById(id)!, {
  user: { id, name: id, email: id + "@example.test", role: "user" },
  path: "/providers", assetBase: location.origin + "/",
  stylesheet: "pointer-ui/" + manifest.stylesheet, fonts: "pointer-ui/" + manifest.fonts,
  theme: "dark", onSignOut() {}, onUnauthorized() { throw new Error("Unexpected unauthorized fixture request"); },
  request: async (path: string, init: RequestInit) => {
    if (init.headers && new Headers(init.headers).has("authorization")) throw new Error("Host credential leaked from local storage");
    requests.push(id + ":" + path);
    if (path === "/api/connections/providers" || path === "/api/connections/models" || path === "/api/groups") return Response.json([]);
    if (path === "/api/connections/oauth/providers") return Response.json({ providers: [] });
    if (path === "/api/connections/codex-auth/accounts") return Response.json({ accounts: [] });
    if (path === "/api/connections/provider-presets") return Response.json({ providers: [] });
    return Response.json({ error: "Unexpected fixture path" }, { status: 404 });
  },
});
(window as any).pointerOne = mount("pointer-one");
(window as any).pointerTwo = mount("pointer-two");
