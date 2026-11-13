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

### Host-owned Settings navigation

A host with its own complete, accessible route navigation may pass
`navigation: "host"` to `mount`. Pointer then renders the same page components
without its sidebar, account footer or theme selector. OpenCodex and icon licence
links remain beneath the content. The default preserves the standalone-style
shell for other hosts; the standalone Next application is unchanged.

The host must expose every relevant route (including administrator routes only
for administrators), update the path through `screen.navigate`, and handle
mobile navigation and current-page/focus states. This is presentation only:
Pointer's server remains responsible for actual route and operation permissions.
YouEye's adapter places these routes under Settings → AI.

For host-owned navigation, optional inherited properties map the semantic palette:
`--pointer-host-background`, `--pointer-host-foreground`, `--pointer-host-card`,
`--pointer-host-muted`, `--pointer-host-muted-foreground`,
`--pointer-host-primary`, `--pointer-host-primary-foreground`,
`--pointer-host-border`, `--pointer-host-ring`, and `--pointer-host-radius`.
`setTheme` still selects the matching light/dark semantic status colors. These
properties affect only this mode and never restyle the host document.

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

A browser fixture mounts two independent Pointer interfaces, a host-navigation
interface, and a host component
using one React runtime. It checks isolated navigation and requests, host CSS and
theme preservation, absence of iframes, container-width adaptation, modal focus
restoration, and unmount while the host and second mount continue to work.
This proves the distribution mechanism, not Crew/YouEye/Market acceptance.
Actual host adapters, update compatibility and resource measurements remain
required before cutover.

## Settings workflows

Providers lists connections with a saved credential or a supported local/no-key
configuration. An empty engine definition or a sign-in placeholder is not a
connection. **Add Provider** opens the searchable provider chooser with bundled
icons and leads to the same setup/detail screen. Configured connections that are
paused, disabled, need sign-in, or cannot report status remain visible with that
state. Discovered model counts do not promise successful inference.

Opening Models reconciles connected engine inventory into the signed-in owner's
catalog before applying availability filters. Concurrent views share discovery;
success has a short freshness window. A failed refresh is immediately retryable
and leaves saved catalog data visible with a warning. Reference metadata and
benchmark downloads remain a separate explicit operation.

**Instances/API** contains each instance's model access and API keys. New keys
are bound to that exact instance; their secret is shown only once. Existing key
detail URLs remain valid, and the old key-list URL leads to Instances/API.
Authorization continues to be enforced by the owner-scoped server endpoints.

Provider identity aliases (including API-key versus sign-in variants) use the
same bundled brand artwork. Added artwork retains the existing MIT notice and
exact package-integrity/file hashes in `public/icons/brands/SOURCES.json`.
Unknown/custom providers use a labelled monogram rather than an invented logo.
Overview uses the same connected-provider inventory as Providers, including
account authentication; absence of a saved API key does not mean absence of a
Codex login.

Model detail requests observed performance through `/api/stats/summary` with the
canonical model ID in the `model` query value. IDs can contain `/`; hosts may
reject encoded separators in route segments. Failure of optional performance
statistics leaves the loaded model details available with an explicit notice.

## Consolidated pages and loading states

The shared and standalone navigation exposes Models, Providers, Instances/API,
Model groups, Search and vision, Overview and Test model (plus administrator-only
Admin). Overview combines the request trend, connected-provider inventory and
personal usage filters, grouping and request history. Filter responses are scoped
to the latest selection so a slower previous query cannot replace current data.
Provider inventory failures remain independent of telemetry failures.

Test model includes direct single/two-target inference and recorded statistical
comparison of up to five model or provider IDs. Recorded comparison reads existing
usage; it does not send prompts. IDs containing slashes remain encoded query
values. Live tests retain their original provider-account selection and limits.

Usage and request diagnostics are part of Overview; recorded comparison and the
proxy test are part of Test model. Server telemetry and authorization are
unchanged.

Loading placeholders follow the content: model tables include their actual
selected benchmark columns, grid view uses cards, Instances/API and API keys use
table rows, and provider/routing/detail pages use their corresponding cards and
forms. Real view/filter controls stay visible during data loading. Skeletons expose
a loading status, hide decorative placeholders from assistive technology and
respect reduced-motion preferences. Embedded hosts should match the destination
layout while the shared module itself loads, without inventing section tabs.

Grid model cards wrap the selected benchmark fields within each card rather
than extending a single unbroken row across adjacent cards or the page edge.
