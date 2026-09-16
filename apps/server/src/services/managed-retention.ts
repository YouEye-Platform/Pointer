import { and, isNotNull, lt } from "drizzle-orm";
import { config } from "../config";
import { db, schema } from "../db";

export async function pruneManagedState(now = new Date()) {
  if (config.mode !== "managed" || !config.platform) return;

  const auditCutoff = new Date(
    now.getTime() - config.platform.auditRetentionDays * 24 * 60 * 60 * 1000
  );

  await db.transaction(async (tx) => {
    await tx
      .update(schema.credentialDeliveries)
      .set({
        payloadEncrypted: null,
        purgedAt: now,
      })
      .where(
        and(
          lt(schema.credentialDeliveries.expiresAt, now),
          isNotNull(schema.credentialDeliveries.payloadEncrypted)
        )
      );

    await tx
      .delete(schema.platformAssertionReplays)
      .where(lt(schema.platformAssertionReplays.expiresAt, now));
    await tx
      .delete(schema.platformIdempotency)
      .where(lt(schema.platformIdempotency.expiresAt, now));
    await tx
      .delete(schema.managementAudit)
      .where(lt(schema.managementAudit.createdAt, auditCutoff));
  });
}
