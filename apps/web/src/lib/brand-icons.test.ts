import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BRAND_ICONS, brandIcon } from "./brand-icons";

test("every bundled brand mapping names an existing asset", () => {
  for (const file of Object.values(BRAND_ICONS)) assert.ok(existsSync(resolve(import.meta.dirname, "../../public/icons/brands", file)), file);
});
test("setup variants retain their real provider brand and unknown endpoints have no invented brand", () => {
  assert.equal(brandIcon("anthropic-apikey").file, brandIcon("anthropic").file);
  assert.equal(brandIcon("openai-apikey").file, brandIcon("openai").file);
  assert.equal(brandIcon("alibaba-token-plan").file, brandIcon("alibaba").file);
  assert.equal(brandIcon("GOOGLE-VERTEX").file, "vertexai-color.svg");
  assert.equal(brandIcon("owner-custom-endpoint").file, undefined);
});
