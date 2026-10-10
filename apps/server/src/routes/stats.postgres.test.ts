import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createStandaloneApp } from "../app";
import { db, schema } from "../db";
import { signJwt } from "../middleware/auth";

const enabled = process.env.POINTER_ENGINE_POSTGRES_TEST === "1";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("/pointer_engine_test"))
  throw new Error("Stats acceptance requires the disposable engine test database");
(enabled ? test : test.skip)("usage totals and daily/provider breakdown exceed int32 without losing numeric JSON", async () => {
  const id = "stats-overflow-" + crypto.randomUUID();
  await db.insert(schema.users).values({ id, kind: "local", email: `${id}@example.test`, name: "Stats fixture", passwordHash: "fixture", role: "user" });
  try {
    await db.insert(schema.usageLogs).values([0, 1].map(index => ({ id: `${id}-${index}`, userId: id,
      modelId: "fixture", providerId: "fixture", inputTokens: 1_500_000_000, outputTokens: 1_500_000_000,
      cachedTokens: 1_500_000_000, cacheReadTokens: 1_500_000_000 })));
    const token = await signJwt({ id, email: `${id}@example.test`, name: "Stats fixture", role: "user" });
    const app = createStandaloneApp();
    for (const path of ["/api/stats/summary", "/api/stats/provider/fixture", "/api/stats/breakdown?group=provider"]) {
      const response = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      const totals = body.totals ?? body.items[0];
      expect(totals.inputTokens).toBe(3_000_000_000);
      expect(totals.outputTokens).toBe(3_000_000_000);
      if (body.totals) {
        expect(totals.cachedTokens).toBe(6_000_000_000);
        expect(body.daily[0].inputTokens).toBe(3_000_000_000);
      }
    }
  } finally {
    await db.delete(schema.usageLogs).where(eq(schema.usageLogs.userId, id));
    await db.delete(schema.users).where(eq(schema.users.id, id));
  }
});
