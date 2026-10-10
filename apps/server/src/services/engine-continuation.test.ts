import { expect, test } from "bun:test";
import { ContinuationScope } from "./engine-continuation";

test("conversation identity is stable on retry and separated by owner, instance and child", () => {
  const make = (owner: string, instance: string, id: string, request = "request-one") =>
    new ContinuationScope("fixture-secret", owner, instance)
      .requestHeaders(new Headers({ "x-opencode-session": id }), request).get("session_id");
  const root = make("owner", "app", "crew-session");
  expect(root).toBe(make("owner", "app", "crew-session", "request-two"));
  expect(root).not.toBe(make("other-owner", "app", "crew-session"));
  expect(root).not.toBe(make("owner", "other-app", "crew-session"));
  expect(root).not.toBe(make("owner", "app", "crew-session:child"));
  expect(root).not.toContain("crew-session");
});

test("headers retain protocol features without forwarding credentials or arbitrary metadata", () => {
  const scope = new ContinuationScope("fixture-secret", "owner", "app");
  const result = scope.requestHeaders(new Headers({ authorization: "Bearer private-fixture", "x-api-key": "private-fixture",
    "session_id": "native-child", "anthropic-beta": "fixture-beta", "anthropic-version": "2023-06-01",
    cookie: "fixture-cookie", "x-unknown": "fixture" }), "request");
  expect(result.get("anthropic-beta")).toBe("fixture-beta");
  expect(result.get("session_id")).toBe(result.get("x-opencode-session"));
  for (const name of ["authorization", "x-api-key", "cookie", "x-unknown"]) expect(result.has(name)).toBe(false);
  const invalid = new Headers({ "x-opencode-session": "../invalid-session" });
  expect(scope.requestHeaders(invalid, "one").get("session_id"))
    .not.toBe(scope.requestHeaders(invalid, "two").get("session_id"));
});
