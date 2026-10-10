import { createRoot } from "react-dom/client";
import DashboardLayout from "../app/(dashboard)/layout";
import Dashboard from "../app/(dashboard)/dashboard/page";
import Connections from "../app/(dashboard)/connections/page";
import Models from "../app/(dashboard)/models/page";
import Model from "../app/(dashboard)/models/[slug]/page";
import Groups from "../app/(dashboard)/groups/page";
import Group from "../app/(dashboard)/groups/[id]/page";
import Instances from "../app/(dashboard)/instances/page";
import Instance from "../app/(dashboard)/instances/[id]/page";
import Keys from "../app/(dashboard)/keys/page";
import Key from "../app/(dashboard)/keys/[id]/page";
import Usage from "../app/(dashboard)/usage/page";
import Compare from "../app/(dashboard)/compare/page";
import Chat from "../app/(dashboard)/chat/page";
import TestModel from "../app/(dashboard)/test-model/page";
import Diagnostics from "../app/(dashboard)/diagnostics/page";
import Routing from "../app/(dashboard)/routing/page";
import Admin from "../app/(dashboard)/admin/page";
import Providers from "../app/(dashboard)/providers/page";
import Provider from "../app/(dashboard)/providers/[id]/page";
import { configureHostRuntime, type HostRuntime } from "../lib/host-runtime";
import { useAuth } from "../lib/store";
import { navigate, setNavigationCallback, usePathname } from "./navigation";

const routes: Record<string, React.ComponentType> = {
  diagnostics: Diagnostics, routing: Routing, dashboard: Dashboard, connections: Connections, models: Models, groups: Groups,
  instances: Instances, keys: Keys, usage: Usage, compare: Compare, chat: Chat,
  "test-model": TestModel, admin: Admin, providers: Providers,
};
const details: Record<string, React.ComponentType> = { models: Model, groups: Group, instances: Instance, keys: Key, providers: Provider };
function App() {
  const path = usePathname();
  const parts = path.split("/");
  const Page = (parts[2] ? details : routes)[parts[1] || "dashboard"];
  return <DashboardLayout><div key={path}>{Page ? <Page /> : <p>This Pointer screen is unavailable.</p>}</div></DashboardLayout>;
}
export type MountOptions = Pick<HostRuntime, "user" | "request" | "assetBase" | "onSignOut" | "onUnauthorized"> & {
  stylesheet: string; fonts: string; path?: string; theme?: "light" | "dark"; onNavigate?: (path: string) => void;
};
let mounted = false;
/** Mount once per factory instance; host provides authentication and shared React. */
export function mount(element: HTMLElement, options: MountOptions) {
  if (mounted || element.shadowRoot?.childNodes.length) throw new Error("Pointer mount already exists");
  const assets = new URL(options.assetBase, location.href);
  if (!assets.pathname.endsWith("/")) throw new Error("assetBase must end in a slash");
  if (!["http:", "https:"].includes(assets.protocol)) throw new Error("Invalid asset origin");
  mounted = true;
  const abort = new AbortController();
  const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
  // Font declarations must belong to the document's font set. This stylesheet
  // contains only Pointer's two @font-face rules, never host element styling.
  const fontUrl = new URL(options.fonts, assets).href;
  let fonts = Array.from(document.querySelectorAll<HTMLLinkElement>("link[data-pointer-fonts]"))
    .find(link => link.href === fontUrl);
  if (!fonts) {
    fonts = document.createElement("link"); fonts.rel = "stylesheet"; fonts.href = fontUrl;
    fonts.dataset.pointerFonts = "0"; document.head.append(fonts);
  }
  fonts.dataset.pointerFonts = String(Number(fonts.dataset.pointerFonts) + 1);
  const styles = document.createElement("link");
  styles.rel = "stylesheet";
  styles.href = new URL(options.stylesheet, assets).href;
  const container = document.createElement("div");
  container.className = "pointer-root";
  shadow.append(styles, container);
  element.dataset.theme = options.theme ?? "light";
  configureHostRuntime({ ...options, assetBase: assets.href, element, navigate,
    signal: abort.signal });
  setNavigationCallback(options.onNavigate);
  navigate(options.path ?? "/dashboard", false);
  useAuth.setState({ user: options.user, token: null, loading: false });
  const root = createRoot(container);
  root.render(<App />);
  let disposed = false;
  return {
    navigate: (path: string) => navigate(path, false),
    setTheme: (theme: "light" | "dark") => { element.dataset.theme = theme; },
    unmount() {
      if (disposed) return;
      disposed = true;
      abort.abort(); root.unmount(); shadow.replaceChildren();
      fonts!.dataset.pointerFonts = String(Number(fonts!.dataset.pointerFonts) - 1);
      if (fonts!.dataset.pointerFonts === "0") fonts!.remove();
      useAuth.setState({ user: null, token: null, loading: true });
      setNavigationCallback(undefined); configureHostRuntime(null);
    },
  };
}
