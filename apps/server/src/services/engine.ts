import { resolve } from "node:path";
import { EnginePool } from "@pointer/engine";
import { config } from "../config";

function positiveInteger(name: string, fallback: number) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

// Place this separate account-state root on private persistent storage and
// retain it alongside PostgreSQL during backup and restore.
export const enginePool = new EnginePool(
  resolve(process.env.POINTER_ENGINE_STATE_DIR ?? (config.mode === "managed" ? "/var/lib/pointer/engine" : "./data/engine")),
  positiveInteger("POINTER_ENGINE_PROCESSES", 2),
  positiveInteger("POINTER_ENGINE_IDLE_MS", 300_000),
);

export const initialEngineConfig = { providers: {}, defaultProvider: "openai",
  webSearchSidecar: { enabled: false }, visionSidecar: { enabled: false } };
