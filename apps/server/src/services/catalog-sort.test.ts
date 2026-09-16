import { describe, expect, test } from "bun:test";
import { catalogSortDirection } from "./catalog-sort";

describe("catalog sort direction", () => {
  test("shows the newest releases first by default", () => {
    expect(catalogSortDirection("newest")).toBe(-1);
  });

  test("keeps benchmark recommendations best-first and honors explicit order", () => {
    expect(catalogSortDirection("recommended")).toBe(1);
    expect(catalogSortDirection("benchmark:lmarena-agent")).toBe(-1);
    expect(catalogSortDirection("newest", "asc")).toBe(1);
    expect(catalogSortDirection("name", "desc")).toBe(-1);
  });
});
