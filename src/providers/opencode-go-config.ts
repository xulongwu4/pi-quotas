import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface OpenCodeGoConfig {
  apiKey?: string;
  authCookie?: string;
  workspaceId?: string;
}

export type ResolvedOpenCodeGoConfig =
  | { state: "none" }
  | { state: "configured"; config: OpenCodeGoConfig; source: string }
  | { state: "incomplete"; source: string; missing: string }
  | { state: "invalid"; source: string; error: string };

function getConfigCandidatePaths(): string[] {
  const home = homedir();
  return [
    join(home, ".config", "opencode", "opencode-quota", "opencode-go.json"),
    join(home, ".config", "opencode-go", "config.json"),
  ];
}

async function readConfigFile(
  path: string,
): Promise<
  | { state: "missing" }
  | { state: "loaded"; config: Partial<OpenCodeGoConfig> }
  | { state: "invalid"; error: string }
> {
  try {
    const data = await readFile(path, "utf-8");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        state: "invalid",
        error: "Config file must contain a JSON object",
      };
    }
    return { state: "loaded", config: parsed as Partial<OpenCodeGoConfig> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { state: "missing" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "invalid",
      error: `Failed to read config file: ${message}`,
    };
  }
}

export function resolveOpenCodeGoConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOpenCodeGoConfig | null {
  const apiKey = (env.OPENCODE_API_KEY ?? env.OPENCODE_GO_API_KEY)?.trim();
  const workspaceId = env.OPENCODE_GO_WORKSPACE_ID?.trim();
  const authCookie = env.OPENCODE_GO_AUTH_COOKIE?.trim();

  if (!apiKey && !workspaceId && !authCookie) return null;

  if (apiKey) {
    return {
      state: "configured",
      config: { apiKey, authCookie, workspaceId },
      source: "env",
    };
  }

  if (authCookie) {
    return {
      state: "configured",
      config: { authCookie, workspaceId },
      source: "env",
    };
  }

  if (workspaceId && !authCookie) {
    return {
      state: "incomplete",
      source: "env",
      missing: "OPENCODE_GO_AUTH_COOKIE or OPENCODE_API_KEY",
    };
  }

  return null;
}

export async function resolveOpenCodeGoConfig(): Promise<ResolvedOpenCodeGoConfig> {
  const envResult = resolveOpenCodeGoConfigFromEnv();
  if (envResult) return envResult;

  const candidates = getConfigCandidatePaths();
  for (const path of candidates) {
    const fileResult = await readConfigFile(path);
    if (fileResult.state === "missing") continue;
    if (fileResult.state === "invalid") {
      return { state: "invalid", source: path, error: fileResult.error };
    }

    const config = fileResult.config;
    const apiKey =
      typeof config.apiKey === "string" ? config.apiKey.trim() : undefined;
    const workspaceId =
      typeof config.workspaceId === "string" ? config.workspaceId.trim() : undefined;
    const authCookie =
      typeof config.authCookie === "string" ? config.authCookie.trim() : undefined;

    if (apiKey || authCookie) {
      return {
        state: "configured",
        config: { apiKey, authCookie, workspaceId },
        source: path,
      };
    }

    if (workspaceId && !authCookie && !apiKey) {
      return { state: "incomplete", source: path, missing: "apiKey or authCookie" };
    }
  }

  return { state: "none" };
}

let cachedConfig: ResolvedOpenCodeGoConfig | null = null;
let cachedAt = 0;

const CACHE_MAX_AGE_MS = 30_000;

export async function resolveOpenCodeGoConfigCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedOpenCodeGoConfig> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? CACHE_MAX_AGE_MS);
  const now = Date.now();
  if (cachedConfig && now - cachedAt < maxAgeMs) {
    return cachedConfig;
  }
  cachedConfig = await resolveOpenCodeGoConfig();
  cachedAt = now;
  return cachedConfig;
}
