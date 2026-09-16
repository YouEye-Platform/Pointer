import { and, eq, sql } from "drizzle-orm";
import type { PointerSurface } from "@pointer/contracts/capabilities";
import { config } from "../config";
import { db, schema } from "../db";
import { LATEST_POINTER_SCHEMA_VERSION } from "../db/latest-schema.mjs";
import { registry } from "../providers/registry";
import { buildInfo } from "./build-info";
import { loadManagedIntegration } from "./managed-platform";

export async function readiness(surface: PointerSurface) {
  const checks: Array<{
    code: string;
    status: "ok" | "degraded" | "error";
    summary: string;
  }> = [];

  try {
    await db.execute(sql`select 1`);
    checks.push({ code: "database", status: "ok", summary: "Database is reachable" });
  } catch {
    return {
      httpStatus: 503 as const,
      body: {
        status: "error",
        surface,
        contractVersion: "1",
        checks: [
          {
            code: "database_unavailable",
            status: "error",
            summary: "Database is unavailable",
          },
        ],
        build: buildInfo,
      },
    };
  }

  const [schemaVersion] = await db
    .select({ version: schema.pointerSchemaVersions.version })
    .from(schema.pointerSchemaVersions)
    .where(eq(schema.pointerSchemaVersions.version, LATEST_POINTER_SCHEMA_VERSION))
    .limit(1)
    .catch(() => []);
  if (!schemaVersion) {
    checks.push({
      code: "schema_incompatible",
      status: "error",
      summary: "Required database schema version is not applied",
    });
  } else {
    checks.push({ code: "schema", status: "ok", summary: "Database schema is compatible" });
  }

  checks.push(
    registry.isInitialized()
      ? { code: "provider_registry", status: "ok", summary: "Provider registry is initialized" }
      : {
          code: "provider_registry_unavailable",
          status: "error",
          summary: "Provider registry is not initialized",
        }
  );

  try {
    const [activeCatalog] = await db
      .select({ id: schema.catalogGenerations.id })
      .from(schema.catalogGenerations)
      .where(eq(schema.catalogGenerations.state, "active"))
      .limit(1);
    checks.push(
      activeCatalog
        ? { code: "catalog", status: "ok", summary: "An active catalog is available" }
        : {
            code: "catalog_unavailable",
            status: "degraded",
            summary: "No active catalog is available yet",
          }
    );
  } catch {
    checks.push({
      code: "catalog_check_failed",
      status: "error",
      summary: "Catalog readiness could not be checked",
    });
  }

  if (config.mode === "managed") {
    try {
      const integration = await loadManagedIntegration();
      if (!integration || integration.ownerKind !== "service" || integration.ownerState !== "active") {
        checks.push({
          code: "managed_principal_invalid",
          status: "error",
          summary: "Managed integration and service principal do not agree",
        });
      } else {
        const defaults = await db
          .select({ id: schema.modelGroups.id })
          .from(schema.modelGroups)
          .where(
            and(
              eq(schema.modelGroups.userId, integration.ownerUserId),
              eq(schema.modelGroups.isDefault, true)
            )
          );
        checks.push(
          defaults.length === 1
            ? {
                code: "managed_default_group",
                status: "ok",
                summary: "Managed default-group invariant is satisfied",
              }
            : {
                code: "managed_default_group_invalid",
                status: "error",
                summary: "Managed default-group invariant is not satisfied",
              }
        );
        if (defaults.length === 1) {
          await db
            .update(schema.platformIntegrations)
            .set({ lastReadyAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.platformIntegrations.id, integration.id));
        }
      }
    } catch {
      checks.push({
        code: "managed_configuration_unsafe",
        status: "error",
        summary: "Managed configuration readiness could not be verified",
      });
    }
  }

  const hasError = checks.some((check) => check.status === "error");
  const degraded = checks.some((check) => check.status === "degraded");
  return {
    httpStatus: hasError ? (503 as const) : (200 as const),
    body: {
      status: hasError ? "error" : degraded ? "degraded" : "ok",
      surface,
      contractVersion: "1",
      checks,
      build: buildInfo,
    },
  };
}
