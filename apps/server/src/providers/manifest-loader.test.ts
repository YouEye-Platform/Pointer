import { describe, expect, test } from "bun:test";
import { loadHandler } from "./manifest-loader";

describe("provider handler packaging", () => {
  test.each(["codex", "google-gemini", "xai-grok"])(
    "loads the repository-owned %s handler from the server bundle",
    async (handlerId) => {
      await expect(loadHandler(handlerId)).resolves.not.toBeNull();
    },
  );
});
