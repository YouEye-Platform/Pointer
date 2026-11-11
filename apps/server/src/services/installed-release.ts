import { constants } from "node:fs";
import { open } from "node:fs/promises";

export type InstalledRelease = {
  version: string; channel: string; buildVersion: string; releaseSHA256: string;
};

// The platform publishes this projection only after checking the release
// metadata and the sha256 digests of the immutable build payload. It is outside
// the application code tree and is read on each request so promotion needs no
// service restart.
export async function installedRelease(product: string, buildVersion: string): Promise<InstalledRelease | null> {
  let file;
  try {
    file = await open("/etc/youeye/installed-release.json", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022 || stat.size < 1 || stat.size > 16384) return null;
    const bytes = Buffer.alloc(16385);
    const { bytesRead } = await file.read(bytes,0,bytes.length,0);
    if (bytesRead !== stat.size) return null;
    const r = JSON.parse(bytes.subarray(0,bytesRead).toString("utf8"));
    if (r.schema !== "youeye.installed-product.v1" || r.product !== product || r.build_version !== buildVersion ||
        typeof r.version !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[a-z][a-z0-9-]*\.[1-9][0-9]*)?$/.test(r.version) ||
        !["stable","beta","alpha","dev","feature"].includes(r.channel) || !/^[0-9a-f]{64}$/.test(r.release_sha256) || !/^[0-9a-f]{64}$/.test(r.build_sha256)) return null;
    return {version:r.version,channel:r.channel,buildVersion,releaseSHA256:r.release_sha256};
  } catch { return null; }
  finally { await file?.close(); }
}
