export const PUBLIC_CANONICAL_REPOSITORY = "https://github.com/YouEye-Platform/Pointer";

// Product identity and checkout provenance are different. The signed Infra
// provenance binds the exact source; optional checkout locators must be retained
// verbatim, never replaced with a claim of GitHub publication.
export function buildSourceRepository(value) {
  if (value === undefined || value === "") return null;
  if (value === "Pointer") return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password &&
        !url.search && !url.hash && /^\/[^/]+\/Pointer(?:\.git)?$/.test(url.pathname)) return value;
  } catch { /* Report an invalid source locator without echoing its contents. */ }
  throw new Error("source repository does not match a credential-free Pointer source locator");
}

export function publicSourceRepository(value) {
  if (!value) throw new Error("public source repository identity is required");
  if (value !== PUBLIC_CANONICAL_REPOSITORY) {
    throw new Error("source repository does not match Pointer's public canonical repository");
  }
  return value;
}
