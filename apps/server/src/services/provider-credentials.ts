import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { encrypt } from "./encryption";
import type { OAuthCredential } from "../providers/types";
import { serializeOAuthCredential } from "./provider-credential-codec";

export {
  parseProviderCredential,
  serializeOAuthCredential,
  type ParsedProviderCredential,
  type StoredOAuthCredential,
} from "./provider-credential-codec";

export async function replaceProviderOAuthCredential(input: {
  userId: string;
  providerId: string;
  providerAccountId?: string | null;
  credential: OAuthCredential;
  issuer: string;
  clientId: string;
  label: string;
  deviceFlowId?: string;
}): Promise<string> {
  const id = nanoid();
  const encrypted = encrypt(
    serializeOAuthCredential(input.credential, input.issuer, input.clientId)
  );

  await db.transaction(async (tx) => {
    await tx
      .delete(schema.providerKeys)
      .where(
        and(
          eq(schema.providerKeys.userId, input.userId),
          eq(schema.providerKeys.providerId, input.providerId),
          ...(input.providerAccountId
            ? [eq(schema.providerKeys.providerAccountId, input.providerAccountId)]
            : [])
        )
      );
    await tx.insert(schema.providerKeys).values({
      id,
      userId: input.userId,
      providerId: input.providerId,
      providerAccountId: input.providerAccountId,
      apiKeyEncrypted: encrypted,
      label: input.label,
    });
    if (input.deviceFlowId) {
      await tx
        .delete(schema.providerOAuthDeviceFlows)
        .where(and(
          eq(schema.providerOAuthDeviceFlows.id, input.deviceFlowId),
          eq(schema.providerOAuthDeviceFlows.userId, input.userId),
          eq(schema.providerOAuthDeviceFlows.providerId, input.providerId)
        ));
    }
  });

  return id;
}
