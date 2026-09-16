const optionalEnv = (name: string): string | null => {
  const value = process.env[name]?.trim();
  return value ? value : null;
};

export const buildInfo = Object.freeze({
  component: "server",
  version: optionalEnv("POINTER_COMPONENT_VERSION") ?? "0.2.0",
  repository: optionalEnv("POINTER_BUILD_REPOSITORY"),
  branch: optionalEnv("POINTER_BUILD_BRANCH"),
  commit: optionalEnv("POINTER_BUILD_COMMIT"),
  builtAt: optionalEnv("POINTER_BUILD_AT"),
});
