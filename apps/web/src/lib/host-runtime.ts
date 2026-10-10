import type { User } from "./store";

export type HostRuntime = {
  user: User;
  request: (path: string, init: RequestInit) => Promise<Response>;
  assetBase: string;
  element: HTMLElement;
  navigate: (path: string) => void;
  onSignOut: () => void;
  onUnauthorized: () => void;
  signal: AbortSignal;
};

// The distributed module is a factory. Each mount gets its own module graph,
// auth store, navigation and temporary storage, while sharing the host's React.
let host: HostRuntime | null = null;
const memory = new Map<string, string>();
export const getHostRuntime = () => host;
export function configureHostRuntime(value: HostRuntime | null) { host = value; memory.clear(); }
export const pointerStorage = {
  getItem(key: string) { return host ? memory.get(key) ?? null : typeof window === "undefined" ? null : localStorage.getItem(key); },
  setItem(key: string, value: string) { if (host) memory.set(key, value); else localStorage.setItem(key, value); },
  removeItem(key: string) { if (host) memory.delete(key); else localStorage.removeItem(key); },
};
export function assetPath(path: string) {
  return host ? new URL(path.replace(/^\//, ""), host.assetBase).href : path;
}
export function navigatePointer(path: string) {
  if (host) host.navigate(path);
  else window.location.replace(path);
}
