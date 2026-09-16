import { z } from "zod";

export const DEPLOYMENT_MODES = ["standalone", "managed"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

const positiveInteger = (name: string, fallback: number) => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

const port = (name: string, fallback?: number) => {
  const raw = process.env[name]?.trim();
  if (!raw && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
};

const optional = (name: string) => {
  const value = process.env[name]?.trim();
  return value || null;
};

const boolean = (name: string, fallback: boolean) => {
  const value = optional(name);
  if (value === null) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
};

const required = (name: string) => {
  const value = optional(name);
  if (!value) throw new Error(`${name} is required in managed mode`);
  return value;
};

const bind = (name: string, fallback: string) => {
  const value = optional(name) ?? fallback;
  if (value.length > 255 || /[\s/]/.test(value)) {
    throw new Error(`${name} must be a hostname or IP address`);
  }
  return value;
};

const algorithms = (raw: string | null) => {
  const values = (raw ?? "RS256,ES256")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = new Set(["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"]);
  if (values.length === 0 || values.some((value) => !allowed.has(value))) {
    throw new Error(
      "PLATFORM_SIGNING_ALGORITHMS must contain only approved asymmetric algorithms"
    );
  }
  return [...new Set(values)];
};

export type PointerConfig = {
  mode: DeploymentMode;
  backgroundJobsEnabled: boolean;
  standalone: {
    bind: string;
    port: number;
    corsOrigin: string;
  };
  management: {
    bind: string;
    port: number;
    corsOrigin: string | null;
  } | null;
  inference: {
    bind: string;
    port: number;
  } | null;
  platform: {
    issuer: string;
    audience: string;
    subject: string;
    jwksUrl: string;
    signingAlgorithms: string[];
    maxAssertionLifetimeSeconds: number;
    clockSkewSeconds: number;
    jwksCooldownSeconds: number;
    jwksCacheSeconds: number;
    integrationId: string;
    servicePrincipalName: string;
    credentialDeliveryTtlSeconds: number;
    idempotencyTtlSeconds: number;
    auditRetentionDays: number;
  } | null;
};

export function loadConfig(): PointerConfig {
  const parsedMode = z.enum(DEPLOYMENT_MODES).safeParse(
    optional("POINTER_DEPLOYMENT_MODE") ?? "standalone"
  );
  if (!parsedMode.success) {
    throw new Error("POINTER_DEPLOYMENT_MODE must be standalone or managed");
  }

  const mode = parsedMode.data;
  const standalonePort = port("PORT", 4000);
  const standaloneBind = bind("BIND", "0.0.0.0");
  const corsOrigin = optional("CORS_ORIGIN");

  if (mode === "standalone") {
    if (!corsOrigin) throw new Error("CORS_ORIGIN is required in standalone mode");
    return {
      mode,
      backgroundJobsEnabled: boolean("POINTER_BACKGROUND_JOBS_ENABLED", true),
      standalone: {
        bind: standaloneBind,
        port: standalonePort,
        corsOrigin,
      },
      management: null,
      inference: null,
      platform: null,
    };
  }

  const managementBind = bind("MANAGEMENT_BIND", "127.0.0.1");
  const managementPort = port("MANAGEMENT_PORT");
  const inferenceBind = bind("INFERENCE_BIND", "0.0.0.0");
  const inferencePort = port("INFERENCE_PORT");
  if (managementBind === inferenceBind && managementPort === inferencePort) {
    throw new Error("Managed management and inference listeners must be distinct");
  }

  const managementCorsOrigin = optional("MANAGEMENT_CORS_ORIGIN");
  if (managementCorsOrigin === "*") {
    throw new Error("MANAGEMENT_CORS_ORIGIN must not be a wildcard in managed mode");
  }

  const issuer = required("PLATFORM_ISSUER");
  const audience = required("PLATFORM_AUDIENCE");
  const subject = required("PLATFORM_SUBJECT");
  const integrationId = required("PLATFORM_INTEGRATION_ID");
  const jwksUrl = required("PLATFORM_JWKS_URL");
  const parsedJwksUrl = z.string().url().safeParse(jwksUrl);
  if (!parsedJwksUrl.success) throw new Error("PLATFORM_JWKS_URL must be a valid URL");
  const jwks = new URL(parsedJwksUrl.data);
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
  if (jwks.protocol !== "https:" && !(jwks.protocol === "http:" && loopback.has(jwks.hostname))) {
    throw new Error("PLATFORM_JWKS_URL must use HTTPS except on loopback");
  }
  if (integrationId.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(integrationId)) {
    throw new Error("PLATFORM_INTEGRATION_ID has an invalid format");
  }

  const maxAssertionLifetimeSeconds = positiveInteger(
    "PLATFORM_MAX_ASSERTION_SECONDS",
    300
  );
  if (maxAssertionLifetimeSeconds > 900) {
    throw new Error("PLATFORM_MAX_ASSERTION_SECONDS must not exceed 900");
  }
  const clockSkewSeconds = positiveInteger("PLATFORM_CLOCK_SKEW_SECONDS", 30);
  if (clockSkewSeconds > 120) {
    throw new Error("PLATFORM_CLOCK_SKEW_SECONDS must not exceed 120");
  }
  const jwksCooldownSeconds = positiveInteger("PLATFORM_JWKS_COOLDOWN_SECONDS", 30);
  if (jwksCooldownSeconds > 300) {
    throw new Error("PLATFORM_JWKS_COOLDOWN_SECONDS must not exceed 300");
  }
  const jwksCacheSeconds = positiveInteger("PLATFORM_JWKS_CACHE_SECONDS", 300);
  if (jwksCacheSeconds > 3600) {
    throw new Error("PLATFORM_JWKS_CACHE_SECONDS must not exceed 3600");
  }
  const servicePrincipalName =
    optional("MANAGED_SERVICE_PRINCIPAL_NAME") ?? "Managed AI gateway";
  if (servicePrincipalName.length > 200) {
    throw new Error("MANAGED_SERVICE_PRINCIPAL_NAME must not exceed 200 characters");
  }

  return {
    mode,
    backgroundJobsEnabled: boolean("POINTER_BACKGROUND_JOBS_ENABLED", true),
    standalone: {
      bind: standaloneBind,
      port: standalonePort,
      corsOrigin: corsOrigin ?? "http://127.0.0.1",
    },
    management: {
      bind: managementBind,
      port: managementPort,
      corsOrigin: managementCorsOrigin,
    },
    inference: {
      bind: inferenceBind,
      port: inferencePort,
    },
    platform: {
      issuer,
      audience,
      subject,
      jwksUrl: parsedJwksUrl.data,
      signingAlgorithms: algorithms(optional("PLATFORM_SIGNING_ALGORITHMS")),
      maxAssertionLifetimeSeconds,
      clockSkewSeconds,
      jwksCooldownSeconds,
      jwksCacheSeconds,
      integrationId,
      servicePrincipalName,
      credentialDeliveryTtlSeconds: positiveInteger(
        "CREDENTIAL_DELIVERY_TTL_SECONDS",
        600
      ),
      idempotencyTtlSeconds: positiveInteger("IDEMPOTENCY_TTL_SECONDS", 86_400),
      auditRetentionDays: positiveInteger("AUDIT_RETENTION_DAYS", 365),
    },
  };
}

export const config = loadConfig();
