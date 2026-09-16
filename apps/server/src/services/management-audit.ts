import { nanoid } from "nanoid";
import { db, schema } from "../db";
import type { ManagementPrincipal } from "../middleware/auth";
import { buildInfo } from "./build-info";

function safeId(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, "_");
  return normalized.slice(0, 300);
}

function safeState(value: Record<string, unknown> | null | undefined) {
  if (!value) return null;
  const allowed: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (
      item === null
      || typeof item === "boolean"
      || typeof item === "number"
      || (typeof item === "string" && item.length <= 300)
    ) {
      allowed[key] = item;
    }
  }
  return allowed;
}

export async function auditManagementAction(input: {
  principal: ManagementPrincipal;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  oldState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  outcome: "success" | "failure";
  errorCode?: string | null;
}) {
  if (input.principal.mode !== "managed" || !input.principal.integrationId || !input.principal.actor) {
    return;
  }
  await db.insert(schema.managementAudit).values({
    id: `aud_${nanoid(18)}`,
    requestId: safeId(input.principal.requestId) ?? "unknown",
    integrationId: input.principal.integrationId,
    actorIssuer: safeId(input.principal.actor.issuer) ?? "unknown",
    actorSubject: safeId(input.principal.actor.subject) ?? "unknown",
    action: safeId(input.action) ?? "unknown",
    targetType: safeId(input.targetType),
    targetId: safeId(input.targetId),
    oldState: safeState(input.oldState),
    newState: safeState(input.newState),
    outcome: input.outcome,
    errorCode: safeId(input.errorCode),
    buildCommit: buildInfo.commit,
    contractVersion: "1",
  });
}
