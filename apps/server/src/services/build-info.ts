const optionalEnv = (name: string): string | null => {
  const value = process.env[name]?.trim();
  return value ? value : null;
};

export const buildInfo = Object.freeze({
  component: "server",
  // The release build inlines the line (YOUEYE_LINE, X.Y.Z) and the git tree (bun build --define),
  // never a build name; development reads the environment.
  version: process.env.YOUEYE_LINE || optionalEnv("POINTER_COMPONENT_VERSION") || "0.0.0",
  sourceTree: process.env.YOUEYE_SOURCE_TREE || null,
  repository: optionalEnv("POINTER_BUILD_REPOSITORY"),
  branch: optionalEnv("POINTER_BUILD_BRANCH"),
  commit: optionalEnv("POINTER_BUILD_COMMIT"),
  builtAt: optionalEnv("POINTER_BUILD_AT"),
});
