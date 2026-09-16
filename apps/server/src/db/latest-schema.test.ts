import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { LATEST_POINTER_SCHEMA_VERSION } from "./latest-schema.mjs";

test("latest schema authority matches the packaged migration set", async () => {
  const migrations = await readdir(new URL("../../drizzle/", import.meta.url));
  const versions = migrations
    .map((name) => /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name)?.[1])
    .filter((version): version is string => version !== undefined)
    .map(Number);

  expect(Math.max(...versions)).toBe(LATEST_POINTER_SCHEMA_VERSION);
});
