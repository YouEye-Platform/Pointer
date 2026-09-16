import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const managedNames = [
  "POINTER_DEPLOYMENT_MODE",
  "MANAGEMENT_BIND",
  "MANAGEMENT_PORT",
  "INFERENCE_BIND",
  "INFERENCE_PORT",
  "MANAGEMENT_CORS_ORIGIN",
  "PLATFORM_ISSUER",
  "PLATFORM_AUDIENCE",
  "PLATFORM_SUBJECT",
  "PLATFORM_INTEGRATION_ID",
  "PLATFORM_JWKS_URL",
  "PLATFORM_SIGNING_ALGORITHMS",
  "PLATFORM_JWKS_COOLDOWN_SECONDS",
  "PLATFORM_JWKS_CACHE_SECONDS",
] as const;
const original = Object.fromEntries(
  [
    ...managedNames,
    "CORS_ORIGIN",
    "PORT",
    "BIND",
    "POINTER_BACKGROUND_JOBS_ENABLED",
  ].map((name) => [
    name,
    process.env[name],
  ])
);

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function managedEnvironment() {
  process.env.POINTER_DEPLOYMENT_MODE = "managed";
  process.env.MANAGEMENT_BIND = "127.0.0.1";
  process.env.MANAGEMENT_PORT = "4100";
  process.env.INFERENCE_BIND = "0.0.0.0";
  process.env.INFERENCE_PORT = "4200";
  process.env.PLATFORM_ISSUER = "https://issuer.example.test";
  process.env.PLATFORM_AUDIENCE = "pointer-management";
  process.env.PLATFORM_SUBJECT = "server-1";
  process.env.PLATFORM_INTEGRATION_ID = "integration-1";
  process.env.PLATFORM_JWKS_URL = "https://issuer.example.test/.well-known/jwks.json";
}

describe("deployment configuration", () => {
  test("preserves standalone defaults without managed settings", () => {
    delete process.env.POINTER_DEPLOYMENT_MODE;
    process.env.CORS_ORIGIN = "http://webui.example.test";
    const value = loadConfig();
    expect(value.mode).toBe("standalone");
    expect(value.standalone.port).toBe(4000);
    expect(value.backgroundJobsEnabled).toBe(true);
    expect(value.platform).toBeNull();
  });

  test("allows background work to be disabled explicitly for canaries", () => {
    delete process.env.POINTER_DEPLOYMENT_MODE;
    process.env.CORS_ORIGIN = "http://webui.example.test";
    process.env.POINTER_BACKGROUND_JOBS_ENABLED = "false";
    expect(loadConfig().backgroundJobsEnabled).toBe(false);

    process.env.POINTER_BACKGROUND_JOBS_ENABLED = "sometimes";
    expect(() => loadConfig()).toThrow("must be true or false");
  });

  test("requires complete isolated managed trust and listeners", () => {
    managedEnvironment();
    const value = loadConfig();
    expect(value.mode).toBe("managed");
    expect(value.management).toMatchObject({ bind: "127.0.0.1", port: 4100 });
    expect(value.inference).toMatchObject({ bind: "0.0.0.0", port: 4200 });
    expect(value.platform?.signingAlgorithms).toEqual(["RS256", "ES256"]);
  });

  test("rejects wildcard management CORS and symmetric algorithms", () => {
    managedEnvironment();
    process.env.MANAGEMENT_CORS_ORIGIN = "*";
    expect(() => loadConfig()).toThrow("must not be a wildcard");

    delete process.env.MANAGEMENT_CORS_ORIGIN;
    process.env.PLATFORM_SIGNING_ALGORITHMS = "HS256";
    expect(() => loadConfig()).toThrow("approved asymmetric algorithms");
  });

  test("rejects a shared managed listener", () => {
    managedEnvironment();
    process.env.INFERENCE_BIND = "127.0.0.1";
    process.env.INFERENCE_PORT = "4100";
    expect(() => loadConfig()).toThrow("listeners must be distinct");
  });
});
