import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function blockedIPv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && octets[2] === 0)
    || (a === 192 && b === 0 && octets[2] === 2)
    || (a === 192 && b === 88 && octets[2] === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && octets[2] === 100)
    || (a === 203 && b === 0 && octets[2] === 113)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

function blockedIPv6(address: string) {
  const normalized = address.toLowerCase();
  const parts = normalized.split(":");
  const first = Number.parseInt(parts[0] || "0", 16);
  const second = Number.parseInt(parts[1] || "0", 16);
  // Permit only global unicast. Exclude the IETF protocol-assignment block,
  // both documentation prefixes, and everything outside 2000::/3. This also
  // excludes mapped IPv4, unique-local, link-local, multicast and NAT64
  // special-use addresses.
  return first < 0x2000
    || first > 0x3fff
    || (first === 0x2001 && second <= 0x01ff)
    || (first === 0x2001 && second === 0x0db8)
    || (first === 0x3fff && second <= 0x0fff);
}

export function isPublicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !blockedIPv4(address) : family === 6 ? !blockedIPv6(address) : false;
}

/** Local routing is an installation policy, not an additional user role. */
export function localEndpointPolicyEnabled(): boolean {
  return process.env.POINTER_ALLOW_LOCAL_ENDPOINTS === "true";
}

export function isAllowedEndpointAddress(address: string, allowLocal = localEndpointPolicyEnabled()): boolean {
  if (address === "168.63.129.16" || address.toLowerCase() === "fd00:ec2::254" || address.toLowerCase() === "fd20:ce::254") return false;
  if (isPublicAddress(address)) return true;
  if (!allowLocal) return false;
  if (isIP(address) === 4) {
    const [a,b] = address.split(".").map(Number);
    // Never expose host/cloud metadata, link-local, unspecified or multicast.
    if (a === 0 || a >= 224 || (a === 169 && b === 254) || address === "100.100.100.200") return false;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || /^f[cd][0-9a-f]{2}:/.test(normalized);
  }
  return false;
}

export async function validateProviderEndpoint(raw: string, allowLocal = localEndpointPolicyEnabled()): Promise<string> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Endpoint must be a valid URL"); }
  if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:")) throw new Error("Endpoint scheme is not allowed by the installation policy");
  if (url.username || url.password) throw new Error("Endpoint URLs must not contain credentials");
  if (url.search || url.hash) throw new Error("Endpoint URLs must not contain a query or fragment");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const results = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true })
    .catch(() => { throw new Error("Endpoint hostname could not be resolved"); });
  if (results.length === 0 || results.some(result => !isAllowedEndpointAddress(result.address, allowLocal))) throw new Error("Endpoint address is not allowed by the installation network policy");
  return url.toString().replace(/\/$/, "");
}

// Kept for existing imports; all account paths use the same policy.
export const validatePublicHttpsEndpoint = validateProviderEndpoint;
