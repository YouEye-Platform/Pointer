import { useSyncExternalStore, type AnchorHTMLAttributes, type ImgHTMLAttributes, type MouseEvent } from "react";
import { assetPath } from "../lib/host-runtime";

let path = "/dashboard";
let announce: ((path: string) => void) | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function navigate(next: string, notify = true) {
  if (!next.startsWith("/") || next.startsWith("//") || /[?#\\]/.test(next)) throw new Error("Invalid Pointer route");
  path = next;
  for (const listener of listeners) listener();
  if (notify) announce?.(path);
}
export function setNavigationCallback(callback?: (path: string) => void) { announce = callback; }
export function usePathname() { return useSyncExternalStore(subscribe, () => path, () => path); }
export function useParams() {
  const parts = usePathname().split("/");
  return { id: decodeURIComponent(parts[2] ?? ""), slug: decodeURIComponent(parts[2] ?? "") };
}
const router = { push: navigate, replace: navigate, refresh: () => { for (const listener of listeners) listener(); } };
export function useRouter() { return router; }
export default function Link({ href, onClick, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string }) {
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target) return;
    if (href.startsWith("/") && !href.startsWith("//")) { event.preventDefault(); navigate(href); }
  };
  return <a {...props} href={href} onClick={click} />;
}
export function Image({ src, unoptimized: _unoptimized, ...props }: ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean }) {
  return <img {...props} src={typeof src === "string" ? assetPath(src) : undefined} />;
}
