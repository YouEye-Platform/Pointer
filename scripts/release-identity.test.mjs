import { describe, expect, test } from "bun:test";
import {
  PUBLIC_CANONICAL_REPOSITORY,
  publicSourceRepository,
} from "./release-identity.mjs";

describe("public release source identity", () => {
  test("accepts only the canonical public repository", () => {
    expect(publicSourceRepository(PUBLIC_CANONICAL_REPOSITORY)).toBe(
      PUBLIC_CANONICAL_REPOSITORY
    );
  });

  test("refuses missing or non-canonical source identity", () => {
    expect(() => publicSourceRepository("")).toThrow("identity is required");
    expect(() => publicSourceRepository("https://git.example.test/Pointer")).toThrow(
      "does not match"
    );
  });
});
