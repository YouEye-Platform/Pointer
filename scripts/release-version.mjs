// Release grammar shared with YouEye core; numeric-depth versions are retained
// only for historical source/candidate inspection.
import { execFileSync } from "node:child_process";
export const RELEASE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([1-9][0-9]*))?$/;
export function isReleaseVersion(value) {
  if (typeof value !== "string") return false;
  const match = RELEASE_VERSION.exec(value);
  return !!match && (match[4]?.length ?? 0) <= 63 && [match[1], match[2], match[3], match[5] ?? "0"].every(part => Number.isSafeInteger(Number(part)));
}
export function isHistoricalVersion(value) {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,9}$/.test(value) && value.split(".").every(part => Number.isSafeInteger(Number(part)));
}
export function validateReleaseBranch(branch) {
  if (typeof branch !== "string" || !branch || branch !== branch.trim() || branch.startsWith("-")) throw new Error("exact Git branch required");
  try { execFileSync("git", ["check-ref-format", `refs/heads/${branch}`], { stdio: "ignore" }); }
  catch { throw new Error("invalid Git branch"); }
}
