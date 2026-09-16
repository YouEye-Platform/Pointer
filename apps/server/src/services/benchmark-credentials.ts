import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { decrypt, encrypt } from "./encryption";

export const ARTIFICIAL_ANALYSIS_SOURCE_ID = "artificial-analysis";

export async function hasBenchmarkCredential(sourceId: string): Promise<boolean> {
  const [row] = await db.select({ sourceId: schema.benchmarkSourceCredentials.sourceId })
    .from(schema.benchmarkSourceCredentials)
    .where(eq(schema.benchmarkSourceCredentials.sourceId, sourceId))
    .limit(1);
  return Boolean(row);
}

export async function getBenchmarkCredential(sourceId: string): Promise<string | null> {
  const [row] = await db.select({ secretEncrypted: schema.benchmarkSourceCredentials.secretEncrypted })
    .from(schema.benchmarkSourceCredentials)
    .where(eq(schema.benchmarkSourceCredentials.sourceId, sourceId))
    .limit(1);
  return row ? decrypt(row.secretEncrypted) : null;
}

export async function saveBenchmarkCredential(sourceId: string, plaintext: string): Promise<void> {
  const now = new Date();
  const secretEncrypted = encrypt(plaintext);
  await db.insert(schema.benchmarkSourceCredentials)
    .values({ sourceId, secretEncrypted, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.benchmarkSourceCredentials.sourceId,
      set: { secretEncrypted, updatedAt: now },
    });
}

export async function deleteBenchmarkCredential(sourceId: string): Promise<void> {
  await db.delete(schema.benchmarkSourceCredentials)
    .where(eq(schema.benchmarkSourceCredentials.sourceId, sourceId));
}
