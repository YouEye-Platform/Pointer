import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const publicContractPath = new URL(
  "../../../../packages/contracts/specs/catalog.v1.schema.json",
  import.meta.url
);

describe("public catalog contract", () => {
  test("publishes the exact V1 list and detail catalog response shapes", async () => {
    const contract = JSON.parse(await readFile(publicContractPath, "utf8")) as {
      oneOf: Array<{ $ref: string }>;
      $defs: Record<string, unknown>;
    };
    const serialized = JSON.stringify(contract);

    expect(serialized).not.toContain('"":');
    expect(contract.oneOf.map((entry) => entry.$ref)).toEqual([
      "#/$defs/corpus",
      "#/$defs/apiListResponse",
      "#/$defs/apiDetailResponse",
    ]);
    const defs = contract.$defs as Record<string, {
      required?: string[];
      allOf?: Array<{ $ref?: string; required?: string[] }>;
    }>;
    expect(defs.apiEnvelope?.required).toEqual([
      "contractVersion", "snapshotId", "generatedAt", "benchmarkDescriptors", "ranking", "sources",
    ]);
    expect(defs.apiListResponse?.allOf?.[0]).toEqual({ $ref: "#/$defs/apiEnvelope" });
    expect(defs.apiListResponse?.allOf?.[1]?.required).toEqual([
      "items", "page", "pageSize", "total", "facets",
    ]);
    expect(defs.apiDetailResponse?.allOf).toEqual([
      { $ref: "#/$defs/apiEnvelope" },
      { $ref: "#/$defs/apiItemFields" },
    ]);
    const itemFields = contract.$defs.apiItemFields as any;
    expect(itemFields.properties.providers.items.required).toContain("providerModelKey");
    expect(itemFields.properties.providers.items.required).toContain("available");
    expect(itemFields.properties.providers.items.additionalProperties).toBe(false);
    const listFields = (contract.$defs.apiListResponse as any).allOf[1].properties;
    expect(listFields.facets.required).toEqual(["creators", "providers"]);
    expect(listFields.facets.properties.providers.items.required).toEqual(["id", "name", "available"]);
    expect(serialized).not.toContain('"credentialUsable"');
    expect(serialized).not.toContain('"instances"');
  });
});
