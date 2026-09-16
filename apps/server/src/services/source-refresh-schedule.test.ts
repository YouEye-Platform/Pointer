import { describe, expect, test } from "bun:test";
import { sourceRefreshDelayMs } from "./source-refresh-schedule";

describe("source refresh scheduling", () => {
  test("uses the normal interval after a successful refresh", () => {
    expect(sourceRefreshDelayMs(6 * 60 * 60 * 1000, 0)).toBe(6 * 60 * 60 * 1000);
  });

  test("retries failures with bounded exponential backoff", () => {
    const normal = 6 * 60 * 60 * 1000;
    expect(sourceRefreshDelayMs(normal, 1)).toBe(5 * 60 * 1000);
    expect(sourceRefreshDelayMs(normal, 2)).toBe(10 * 60 * 1000);
    expect(sourceRefreshDelayMs(normal, 3)).toBe(20 * 60 * 1000);
    expect(sourceRefreshDelayMs(normal, 20)).toBeLessThanOrEqual(normal);
  });
});

