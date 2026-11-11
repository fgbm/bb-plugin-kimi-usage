// Host entry: runs on every enrolled host daemon.
//
// Kimi Code's plan limits live at GET {base}/coding/v1/usages and are
// authenticated with the CLI's own OAuth token. The token rotates every 15
// minutes, so this entry refreshes it through Kimi's OAuth endpoint and writes
// the rotated token back to the CLI's credentials file, exactly where the CLI
// expects to find it next.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type HostUsageResult, type HostWindow } from "./contract.js";

/** Kimi Code CLI's public OAuth client id (from @moonshot-ai/kimi-code). */
const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
/** The usage endpoint rejects requests without a CLI-style User-Agent (403). */
const USER_AGENT = "kimi-code-cli/2.5.3 (bb-kimi-usage)";
const REQUEST_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 60_000;
const REFRESH_LEAD_SECONDS = 120;

interface Credentials {
  path: string;
  data: Record<string, unknown>;
}

interface ProviderConfig {
  baseUrl: string;
  oauthHost: string;
}

const cache = new Map<string, { at: number; result: HostUsageResult }>();
let inflight: Promise<HostUsageResult> | null = null;
const PROFILE_TTL_MS = 10 * 60_000;
let profileCache: { at: number; label: string | null } | null = null;

function kimiHomes(): string[] {
  const homes: string[] = [];
  const override = process.env["KIMI_CODE_HOME"]?.trim();
  if (override !== undefined && override !== "") homes.push(override);
  homes.push(join(homedir(), ".kimi-code"));
  // The legacy Kimi CLI kept the same managed:kimi-code credentials.
  homes.push(join(homedir(), ".kimi"));
  return [...new Set(homes)];
}

function readProviderConfig(home: string): ProviderConfig {
  const configPath = join(home, "config.toml");
  if (!existsSync(configPath)) {
    return { baseUrl: DEFAULT_BASE_URL, oauthHost: DEFAULT_OAUTH_HOST };
  }
  let baseUrl: string | null = null;
  let oauthHost: string | null = null;
  let section = "";
  try {
    for (const raw of readFileSync(configPath, "utf8").split(/\r?\n/u)) {
      const line = raw.trim();
      if (line.startsWith("[")) {
        section = line;
        continue;
      }
      if (!section.includes("managed:kimi-code")) continue;
      const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/u.exec(line);
      if (match === null) continue;
      const value = /^"(.*)"$/u.exec(match[2].trim())?.[1];
      if (value === undefined) continue;
      if (match[1] === "base_url" && value !== "") baseUrl = value;
      if (match[1] === "oauth_host" && value !== "") oauthHost = value;
    }
  } catch {
    // A malformed config falls back to the public endpoints below.
  }
  return {
    baseUrl: (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, ""),
    oauthHost: (oauthHost ?? DEFAULT_OAUTH_HOST).replace(/\/+$/u, ""),
  };
}

function findCredentials(): Credentials | null {
  const candidates: string[] = [];
  for (const home of kimiHomes()) {
    const dir = join(home, "credentials");
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.includes(".bak")) continue;
      candidates.push(join(dir, name));
    }
  }
  const sorted = candidates
    .map((path) => {
      try {
        return { path, mtime: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { path: string; mtime: number } => entry !== null)
    .sort((left, right) => right.mtime - left.mtime);
  const newest = sorted[0];
  if (newest === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(newest.path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return { path: newest.path, data: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
}

function configHomeFor(credentialsPath: string): string {
  // <home>/credentials/<file>.json -> <home>
  const dir = join(credentialsPath, "..", "..");
  return dir;
}

function readString(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function readNumber(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string | null;
  token_type: string | null;
}

async function refreshAccessToken(
  refreshToken: string,
  oauthHost: string,
): Promise<TokenResponse | null> {
  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const response = await fetch(`${oauthHost}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null) return null;
  const payload = parsed as Record<string, unknown>;
  const access = readString(payload, "access_token");
  const refresh = readString(payload, "refresh_token");
  const expiresIn = readNumber(payload, "expires_in");
  if (access === null || refresh === null || expiresIn === null) return null;
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: expiresIn,
    scope: readString(payload, "scope"),
    token_type: readString(payload, "token_type"),
  };
}

function persistToken(credentials: Credentials, token: TokenResponse): Credentials {
  const next: Record<string, unknown> = {
    ...credentials.data,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Math.floor(Date.now() / 1_000) + token.expires_in,
    expires_in: token.expires_in,
    token_type: token.token_type ?? readString(credentials.data, "token_type") ?? "Bearer",
  };
  const scope = token.scope ?? readString(credentials.data, "scope");
  if (scope !== null) next["scope"] = scope;
  try {
    writeFileSync(credentials.path, JSON.stringify(next), { mode: 0o600 });
  } catch {
    // A read-only credentials file still lets this call use the fresh token.
  }
  return { path: credentials.path, data: next };
}

function isFresh(credentials: Credentials): boolean {
  const expiresAt = readNumber(credentials.data, "expires_at");
  if (expiresAt === null) return false;
  return expiresAt - REFRESH_LEAD_SECONDS > Date.now() / 1_000;
}

async function accessToken(
  credentials: Credentials,
  oauthHost: string,
  forceRefresh: boolean,
): Promise<{ token: string | null; credentials: Credentials; expired: boolean }> {
  if (!forceRefresh && isFresh(credentials)) {
    return {
      token: readString(credentials.data, "access_token"),
      credentials,
      expired: false,
    };
  }
  const refreshToken = readString(credentials.data, "refresh_token");
  if (refreshToken === null) {
    return { token: null, credentials, expired: true };
  }
  const token = await refreshAccessToken(refreshToken, oauthHost).catch(() => null);
  if (token === null) {
    // Refresh failed. An unexpired access token may still work.
    return {
      token: isFresh(credentials) ? readString(credentials.data, "access_token") : null,
      credentials,
      expired: true,
    };
  }
  return { token: token.access_token, credentials: persistToken(credentials, token), expired: false };
}

interface RawWindow {
  used_ratio?: unknown;
  reset_time?: unknown;
}

function percentOf(usedRatio: unknown): number | null {
  if (typeof usedRatio !== "number" || !Number.isFinite(usedRatio)) return null;
  return Math.round(usedRatio * 10_000) / 100;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function collectWindows(usages: Record<string, unknown>): HostWindow[] {
  const known: Array<{ key: string; label: string; kind: HostWindow["kind"] }> = [
    { key: "limit_5h", label: "5 hours", kind: "five-hour" },
    { key: "limit_7d", label: "Weekly", kind: "weekly" },
    { key: "limit_daily", label: "Daily", kind: "daily" },
    { key: "limit_month_total", label: "Monthly", kind: "custom" },
  ];
  const windows: HostWindow[] = [];
  for (const entry of known) {
    const raw = usages[entry.key];
    if (typeof raw !== "object" || raw === null) continue;
    const percent = percentOf((raw as RawWindow).used_ratio);
    if (percent === null) continue;
    windows.push({
      id: entry.key,
      label: entry.label,
      kind: entry.kind,
      usedPercent: percent,
      resetsAt: isoOrNull((raw as RawWindow).reset_time),
    });
  }
  // Plans that meter coding separately report limit_month_code instead.
  if (!windows.some((window) => window.id === "limit_month_total")) {
    const raw = usages["limit_month_code"];
    if (typeof raw === "object" && raw !== null) {
      const percent = percentOf((raw as RawWindow).used_ratio);
      if (percent !== null) {
        windows.push({
          id: "limit_month_code",
          label: "Monthly",
          kind: "custom",
          usedPercent: percent,
          resetsAt: isoOrNull((raw as RawWindow).reset_time),
        });
      }
    }
  }
  return windows;
}

async function readPlanLabel(
  token: string,
  baseUrl: string,
): Promise<string | null> {
  const now = Date.now();
  if (profileCache !== null && now - profileCache.at < PROFILE_TTL_MS) {
    return profileCache.label;
  }
  try {
    const response = await fetch(`${baseUrl}/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return profileCache?.label ?? null;
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null) return null;
    const level = (payload as Record<string, unknown>)["user_level_name"];
    const label =
      typeof level === "string" && level.trim() !== "" ? level.trim() : null;
    profileCache = { at: now, label };
    return label;
  } catch {
    return profileCache?.label ?? null;
  }
}

async function readUsage(refresh: boolean): Promise<HostUsageResult> {
  const credentials = findCredentials();
  if (credentials === null) {
    return {
      status: "unauthenticated",
      message: null,
      baseUrl: null,
      planLabel: null,
      windows: [],
      observedAt: null,
    };
  }
  const home = configHomeFor(credentials.path);
  const config = readProviderConfig(home);
  const auth = await accessToken(credentials, config.oauthHost, refresh);
  if (auth.token === null) {
    return {
      status: "expired",
      message: null,
      baseUrl: config.baseUrl,
      planLabel: null,
      windows: [],
      observedAt: null,
    };
  }

  const request = async (token: string) =>
    fetch(`${config.baseUrl}/usages`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  let token = auth.token;
  let response = await request(token);
  if (response.status === 401 || response.status === 403) {
    const retry = await accessToken(auth.credentials, config.oauthHost, true);
    if (retry.token !== null) {
      token = retry.token;
      response = await request(token);
    }
    if (response.status === 401 || response.status === 403) {
      return {
        status: "expired",
        message: null,
        baseUrl: config.baseUrl,
        planLabel: null,
        windows: [],
        observedAt: null,
      };
    }
  }
  if (!response.ok) {
    return {
      status: "error",
      message: `Kimi usage request failed (HTTP ${String(response.status)}).`,
      baseUrl: config.baseUrl,
      planLabel: null,
      windows: [],
      observedAt: null,
    };
  }

  const payload: unknown = await response.json();
  const usages =
    typeof payload === "object" && payload !== null && "usages" in payload
      ? (payload as { usages?: unknown }).usages
      : null;
  if (typeof usages !== "object" || usages === null) {
    return {
      status: "error",
      message: "Kimi usage response had no usages object.",
      baseUrl: config.baseUrl,
      planLabel: null,
      windows: [],
      observedAt: null,
    };
  }
  const windows = collectWindows(usages as Record<string, unknown>);
  const planLabel = await readPlanLabel(token, config.baseUrl);
  return {
    status: "ok",
    message: null,
    baseUrl: config.baseUrl,
    planLabel,
    windows,
    observedAt: Date.now(),
  };
}

async function cachedUsage(refresh: boolean): Promise<HostUsageResult> {
  if (!refresh && inflight !== null) return inflight;
  const credentials = findCredentials();
  const key = credentials?.path ?? "none";
  const hit = cache.get(key);
  if (!refresh && hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.result;
  }
  const run = readUsage(refresh)
    .then((result) => {
      cache.set(key, { at: Date.now(), result });
      return result;
    })
    .catch((error: unknown): HostUsageResult => ({
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      baseUrl: null,
      planLabel: null,
      windows: [],
      observedAt: null,
    }))
    .finally(() => {
      inflight = null;
    });
  inflight = run;
  return run;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    collectUsage: ({ refresh }) => cachedUsage(refresh),
  },
});
