// Persistent CLI config: API base URL + saved credentials (JWT for management,
// ptr_ key for proxy calls). Stored as JSON at $POINTER_CONFIG or
// ~/.config/pointer/config.json.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface CliConfig {
  apiUrl: string;
  token?: string; // JWT for /api/* management endpoints
  apiKey?: string; // ptr_ key for /v1/* proxy endpoints
  userEmail?: string;
  instanceId?: string;
}

const DEFAULT_API_URL = "http://localhost:4000";

export function configPath(): string {
  return process.env.POINTER_CONFIG || join(homedir(), ".config", "pointer", "config.json");
}

export async function loadConfig(): Promise<CliConfig> {
  const path = configPath();
  const file = Bun.file(path);
  if (await file.exists()) {
    try {
      const data = (await file.json()) as Partial<CliConfig>;
      return { apiUrl: data.apiUrl || DEFAULT_API_URL, ...data };
    } catch {
      // Corrupt config — fall back to defaults rather than crashing.
    }
  }
  return { apiUrl: process.env.POINTER_API_URL || DEFAULT_API_URL };
}

export async function saveConfig(cfg: CliConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(cfg, null, 2) + "\n");
}
