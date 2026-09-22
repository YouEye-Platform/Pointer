import type postgres from "postgres";
import { randomUUID } from "node:crypto";

export interface ManagedIdentityTransition {
  integrationId: string;
  oldIssuer: string;
  newIssuer: string;
  audience: string;
  subject: string;
}

export function validateIdentityTransition(value: unknown): ManagedIdentityTransition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid identity transition");
  const input = value as Record<string, unknown>;
  const keys = ["integrationId", "oldIssuer", "newIssuer", "audience", "subject"];
  if (Object.keys(input).some(key => !keys.includes(key))) throw new Error("Unexpected identity transition field");
  for (const key of keys) {
    if (typeof input[key] !== "string" || !input[key] || (input[key] as string).length > 2048
      || /[\s\x00-\x1f\x7f]/.test(input[key] as string)) throw new Error("Invalid identity transition field");
  }
  for (const key of ["oldIssuer", "newIssuer"]) {
    const url = new URL(input[key] as string);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Identity transition requires exact HTTPS issuers");
    }
  }
  if (input.oldIssuer === input.newIssuer) throw new Error("Identity transition must change the issuer");
  return input as unknown as ManagedIdentityTransition;
}

/** Local database-owner operation. Never expose this through a public API or startup config. */
export async function transitionManagedIdentity(
  client: postgres.Sql,
  expectedDatabase: string,
  value: unknown,
  checkOnly: boolean,
): Promise<"ready" | "changed" | "already-applied"> {
  const request = validateIdentityTransition(value);
  if (!/^[A-Za-z0-9_-]+$/.test(expectedDatabase)) throw new Error("Expected database is required");
  return client.begin(async tx => {
    const [database] = await tx`
      SELECT current_database() AS name, pg_has_role(current_user, datdba, 'USAGE') AS owner
      FROM pg_database WHERE datname = current_database()
    `;
    if (database?.name !== expectedDatabase || database.owner !== true) {
      throw new Error("Identity transition requires the expected database owner");
    }
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"managed-platform:" + request.integrationId}))`;
    const [integration] = await tx`
      SELECT p.*, u.kind AS owner_kind, u.state AS owner_state, u.password_hash
      FROM platform_integrations p JOIN users u ON u.id = p.owner_user_id
      WHERE p.external_server_id = ${request.integrationId} FOR UPDATE OF p, u
    `;
    if (!integration || integration.kind !== "youeye" || integration.state !== "active"
      || integration.owner_kind !== "service" || integration.owner_state !== "active"
      || integration.password_hash !== null) throw new Error("Active managed integration required");
    if (integration.expected_audience !== request.audience || integration.expected_subject !== request.subject) {
      throw new Error("Managed audience or subject mismatch");
    }
    if (integration.expected_issuer === request.newIssuer) {
      const [receipt] = await tx`
        SELECT id FROM management_audit WHERE integration_id = ${integration.id}
          AND action = 'platform.identity.transition' AND outcome = 'success'
          AND old_state->>'issuer' = ${request.oldIssuer} AND new_state->>'issuer' = ${request.newIssuer}
        LIMIT 1
      `;
      if (!receipt) throw new Error("No matching identity transition receipt");
      return "already-applied" as const;
    }
    if (integration.expected_issuer !== request.oldIssuer) throw new Error("Expected old managed issuer mismatch");
    if (checkOnly) return "ready" as const;
    await tx`
      UPDATE platform_integrations SET expected_issuer = ${request.newIssuer}, updated_at = now(),
        last_authenticated_at = NULL, last_ready_at = NULL WHERE id = ${integration.id}
    `;
    const auditId = randomUUID();
    await tx`
      INSERT INTO management_audit
        (id, request_id, integration_id, actor_issuer, actor_subject, action,
         target_type, target_id, old_state, new_state, outcome)
      VALUES (${auditId}, ${auditId}, ${integration.id}, ${request.oldIssuer},
        'local-database-owner', 'platform.identity.transition', 'platform_integration',
        ${integration.id}, ${tx.json({ issuer: request.oldIssuer })},
        ${tx.json({ issuer: request.newIssuer })}, 'success')
    `;
    return "changed" as const;
  });
}
