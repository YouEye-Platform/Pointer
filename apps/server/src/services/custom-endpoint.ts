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

export async function validatePublicHttpsEndpoint(raw: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Endpoint must be a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("Custom endpoints must use HTTPS");
  if (url.username || url.password) throw new Error("Endpoint URLs must not contain credentials");
  if (url.search || url.hash) throw new Error("Endpoint URLs must not contain a query or fragment");
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new Error("Endpoint must resolve to a public address");
  }
  const results = await lookup(url.hostname, { all: true, verbatim: true })
    .catch(() => { throw new Error("Endpoint must resolve to a public address"); });
  if (results.length === 0 || results.some((result) => !isPublicAddress(result.address))) {
    throw new Error("Endpoint must resolve only to public addresses");
  }
  return url.toString().replace(/\/$/, "");
}
