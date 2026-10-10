# Shared Pointer interface

Pointer builds the same dashboard pages for its standalone Next application and
an independently delivered browser module. Hosts do not copy these pages. The
module uses their React 19 runtime and mounts into a shadow root; no iframe,
second React runtime, eval, import-map rewrite or host-wide stylesheet is needed.
Rendering Pointer still allocates component state, DOM and request buffers.

## Distribution contract

`pnpm --filter @pointer/web build:embed` writes `public/pointer-ui/manifest.json`
and content-addressed JavaScript, CSS, fonts and provider icons. Both the web
and headless server artifacts include these assets. The management listener serves
them at `/_pointer/ui/`; no separate Next process is needed by an embedded host.
Read the manifest fresh when opening Pointer; cache
hashed files immutably. Preserve a release's hashed files for existing open
clients during upgrades. A host must check `contract === 1` and `react === "19"`
before importing a compatible release. Protocol/API compatibility still needs
acceptance when upgrading either side.

Use a fixed, trusted asset origin or a host-side proxy to Pointer's static assets.
Do not import a user-supplied module URL. A host proxy also avoids cross-origin
module and font policy issues. Its API proxy must continue to authenticate the
host user and produce Pointer's short-lived management assertion on the server;
this UI does not grant authorization or expose the signing key.

```tsx
import * as React from "react";
import { createRoot } from "react-dom/client";

const base = new URL("/pointer-assets/", location.origin);
const manifest = await fetch(new URL("manifest.json", base), {
  cache: "no-store",
}).then(response => response.json());
if (manifest.contract !== 1 || manifest.react !== "19") throw new Error("Incompatible Pointer UI");
const { createPointerUI } = await import(new URL(manifest.entry, base).href);
const screen = createPointerUI({ React, createRoot }).mount(element, {
  assetBase: base.href,
  stylesheet: manifest.stylesheet,
  fonts: manifest.fonts,
  user: currentUser,
  request: authenticatedPointerRequest,
  path: "/providers",
  theme: "dark",
  onNavigate: path => updateHostRoute(path),
  onUnauthorized: () => requestHostAuthentication(),
  onSignOut: () => leavePointer(),
});
// When the host route or theme changes:
screen.navigate("/groups");
screen.setTheme("light");
// On view disposal, abort pending requests and release the UI:
screen.unmount();
```

Each factory invocation owns its module graph, authentication state, temporary
storage and navigation. Supply a fresh factory for each mount. Multiple mounts
can share React without sharing an account's UI state. Embedded Pointer does not
read the host's local storage or redirect the host document on authentication
failure. Hosts own identity changes: unmount the old account before mounting the
new one. The `user` display object is not a substitute for server authorization.

`request(path, init)` accepts relative Pointer API paths and returns a streaming
`Response`. Honor `init.signal`. Management requests use the host's authenticated
server proxy. `/v1/*` Proxy Test requests carry the user's explicitly supplied
Pointer instance key; a host should translate these into its fixed-destination
proxy-test operation, keeping host and instance credentials separate. Do not
store that test key in host local storage. Pointer keeps it only in the mounted
view's memory. Asset requests use `assetBase`, never the management transport.

Crew and YouEye host adapters use one loader and a trusted static-asset proxy,
allow the `/api/connections` management paths, and preserve their separate
Proxy Test operation. Management authentication remains in each host's server.
Host installation and runtime acceptance are separate from packaging checks.

`POINTER_UI_DIR` selects the current public asset directory.
`POINTER_UI_ARCHIVE_DIRS` lists retained public directories separated by colons.
Only the current directory supplies the manifest. Archived content-addressed
assets let an open client finish loading after a compatible server update.
The static route permits exact build filenames, rejects symlink escapes and
never serves engine state, server code, environment files or credentials.

## Evidence and remaining work

A browser fixture mounts two independent Pointer interfaces and a host component
using one React runtime. It checks isolated navigation and requests, host CSS and
theme preservation, absence of iframes, container-width adaptation, modal focus
restoration, and unmount while the host and second mount continue to work.
This proves the distribution mechanism, not Crew/YouEye/Market acceptance.
Actual host adapters, update compatibility and resource measurements remain
required before cutover.
