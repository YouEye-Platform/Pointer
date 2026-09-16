import { describe, expect, test } from "bun:test";
import {
  PUBLIC_CANONICAL_REPOSITORY,
  publicSourceRepository,
  buildSourceRepository,
} from "./release-identity.mjs";

describe("public release source identity", () => {
  test("accepts the exact Infra recipe identity without treating arbitrary sources as Pointer", () => {
    expect(buildSourceRepository("Pointer")).toBe("Pointer");
    expect(buildSourceRepository(PUBLIC_CANONICAL_REPOSITORY)).toBe(PUBLIC_CANONICAL_REPOSITORY);
    expect(() => buildSourceRepository("Other")).toThrow("does not match");
    expect(buildSourceRepository("https://git.example.test/team/Pointer.git")).toBe("https://git.example.test/team/Pointer.git");
    expect(buildSourceRepository(undefined)).toBe(null);
    for (const value of ["http://git.example.test/team/Pointer", "https://user:secret@git.example.test/team/Pointer", "https://git.example.test/team/Other", "https://git.example.test/team/Pointer?token=secret"]) {
      expect(() => buildSourceRepository(value)).toThrow("does not match");
    }
    expect(() => publicSourceRepository("Pointer")).toThrow("does not match");
  });
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
