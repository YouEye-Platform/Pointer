import { z } from "zod";

const managedApplicationIconSchema = z.string().trim().max(2000).refine(
  (value) => /^https:\/\//.test(value) || value.startsWith("/api/market/image?"),
  "The managed application icon must use HTTPS or the YouEye Market image proxy"
);

export const EXTERNAL_INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export const ensureInstallationSchema = z
  .object({
    appId: z.string().trim().min(1).max(200).regex(EXTERNAL_INSTALLATION_ID_PATTERN),
    displayName: z.string().trim().min(1).max(200),
    appVersion: z.string().trim().min(1).max(100).optional(),
    groupId: z.string().trim().min(1).max(200).optional(),
    routingOwner: z.enum(["service", "actor"]).default("service"),
    iconUrl: managedApplicationIconSchema.optional(),
    adapterRevision: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const changeInstallationGroupSchema = z
  .object({
    groupId: z.string().trim().min(1).max(200),
  })
  .strict();

export const takeOverInstallationSchema = changeInstallationGroupSchema;

export const changeActorStateSchema = z
  .object({
    state: z.enum(["active", "disabled"]),
  })
  .strict();

export const changeManagedActorStateSchema = changeActorStateSchema.extend({
  actorSubject: z.string().trim().min(1).max(200),
}).strict();

export const listManagedGroupsQuerySchema = z
  .object({
    owner: z.enum(["service", "actor"]).default("service"),
  })
  .strict();

export const acknowledgementSchema = z
  .object({
    deliveryId: z.string().trim().min(1).max(200),
  })
  .strict();

export const listInstallationsQuerySchema = z
  .object({
    cursor: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    state: z
      .enum(["provisioning", "active", "rotating", "disabled", "archived", "error"])
      .optional(),
  })
  .strict();

export class ManagedServiceError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 500 | 503,
    readonly code: string,
    message: string,
    readonly options: {
      retryable?: boolean;
      details?: Record<string, unknown>;
    } = {}
  ) {
    super(message);
  }
}
