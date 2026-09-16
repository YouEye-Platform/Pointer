export const POINTER_CAPABILITY_CONTRACT_VERSION = "1" as const;
export const POINTER_DEPLOYMENT_MODES = ["standalone", "managed"] as const;
export const POINTER_SURFACES = ["combined", "management", "inference"] as const;

export type PointerDeploymentMode = (typeof POINTER_DEPLOYMENT_MODES)[number];
export type PointerSurface = (typeof POINTER_SURFACES)[number];

export type DeploymentCapabilities = {
  contractVersion: typeof POINTER_CAPABILITY_CONTRACT_VERSION;
  deploymentMode: PointerDeploymentMode;
  localAuthAvailable: boolean;
  surface: PointerSurface;
  managementContractVersion: string;
  inferenceContractVersion: string;
  build?: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function parseDeploymentCapabilities(
  value: unknown
): DeploymentCapabilities {
  if (
    !isRecord(value)
    || value.contractVersion !== POINTER_CAPABILITY_CONTRACT_VERSION
    || !POINTER_DEPLOYMENT_MODES.includes(value.deploymentMode as PointerDeploymentMode)
    || typeof value.localAuthAvailable !== "boolean"
    || !POINTER_SURFACES.includes(value.surface as PointerSurface)
    || typeof value.managementContractVersion !== "string"
    || typeof value.inferenceContractVersion !== "string"
    || (
      value.build !== undefined
      && !isRecord(value.build)
    )
  ) {
    throw new Error("Pointer returned an invalid deployment capability");
  }
  return value as DeploymentCapabilities;
}
