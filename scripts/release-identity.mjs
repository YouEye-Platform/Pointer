export const PUBLIC_CANONICAL_REPOSITORY = "https://github.com/YouEye-Platform/Pointer";

export function publicSourceRepository(value) {
  if (!value) throw new Error("public source repository identity is required");
  if (value !== PUBLIC_CANONICAL_REPOSITORY) {
    throw new Error("source repository does not match Pointer's public canonical repository");
  }
  return value;
}
