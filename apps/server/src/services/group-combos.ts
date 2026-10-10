import { createHash } from "node:crypto";
import { z } from "zod";
export const groupComboSchema = z.object({ name: z.string().trim().min(1).max(80),
  strategy: z.enum(["failover", "round-robin"]),
  targets: z.array(z.object({ entryId: z.string().min(1), weight: z.number().int().min(1).max(100).default(1) })).min(1).max(20),
});
export type GroupCombo = z.infer<typeof groupComboSchema>;
export function groupComboId(owner: string, group: string, name: string) {
  return "ptr_" + createHash("sha256").update(JSON.stringify([owner, group, name])).digest("hex").slice(0, 24);
}
