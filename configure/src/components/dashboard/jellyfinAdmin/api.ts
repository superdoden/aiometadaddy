import { useCallback } from "react";
import { useAdmin } from "@/contexts/AdminContext";
import type { AppConfig } from "@/contexts/config";

const PREFIX = "/api/dashboard/jellyfin-admin";

export type ManagedKind = "master" | "sub";

export interface ManagedEntry {
  uuid: string;
  kind: ManagedKind;
  name: string;
  masterUuid: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OverviewUser {
  id: string;
  name: string;
  main?: boolean;
  lastSignIn: number | null;
  lastPlay: number | null;
}

export interface OverviewConfig {
  uuid: string;
  alias: string | null;
  name: string | null;
  addonName: string | null;
  kind: ManagedKind | null;
  masterUuid: string | null;
  hasJellyfin: boolean;
  catalogCount: number;
  streamUrl: string | null;
  streamName: string | null;
  users: OverviewUser[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SyncResult {
  uuid: string;
  name: string;
  ok: boolean;
  changed?: boolean;
  error?: string;
}

export interface SyncReport {
  at: number;
  results: SyncResult[];
}

export interface Overview {
  jellyfinEnabled: boolean;
  aliasesEnabled: boolean;
  baseUrl: string;
  configs: OverviewConfig[];
  lastSync: Record<string, SyncReport | null>;
}

export interface StreamEntry {
  id: string;
  name: string;
  url: string;
  usage: number;
}

export interface LoadedConfig {
  config: AppConfig & Record<string, unknown>;
  configVersion: number;
  alias: string | null;
  managed: ManagedEntry | null;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Requests to the Jellyfin admin routes, signed like every other dashboard call. */
export function useJellyfinAdminApi() {
  const { adminKey } = useAdmin();

  const request = useCallback(async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (adminKey) headers["x-admin-key"] = adminKey;
    const response = await fetch(`${PREFIX}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(data?.error || `Request failed (${response.status})`, response.status, data?.code);
    return data as T;
  }, [adminKey]);

  return {
    adminKey,
    overview: () => request<Overview>("GET", "/overview"),
    createMaster: (sourceUuid: string, name: string, password: string) =>
      request<{ master: ManagedEntry }>("POST", "/masters", { sourceUuid, name, password }),
    createSub: (masterUuid: string, body: { name: string; password: string; alias?: string; clientPassword?: string; streamUrl?: string }) =>
      request<{ sub: ManagedEntry; alias: string | null; aliasError: string | null }>("POST", `/masters/${masterUuid}/subs`, body),
    syncMaster: (masterUuid: string) => request<SyncReport>("POST", `/masters/${masterUuid}/sync`),
    rename: (uuid: string, name: string) => request<{ entry: ManagedEntry }>("PATCH", `/managed/${uuid}`, { name }),
    remove: (uuid: string) => request<{ deleted: boolean }>("DELETE", `/managed/${uuid}`),
    assign: (uuid: string, masterUuid: string, name?: string) =>
      request<{ entry: ManagedEntry; result: SyncResult }>("POST", `/managed/${uuid}/assign`, { masterUuid, name }),
    loadConfig: (uuid: string) => request<LoadedConfig>("GET", `/config/${uuid}`),
    saveConfig: (uuid: string, config: unknown, baseVersion: number, force?: boolean) =>
      request<{ config: AppConfig; configVersion: number }>("PUT", `/config/${uuid}`, { config, baseVersion, force }),
    setAlias: (uuid: string, alias: string) => request<{ alias: string }>("PUT", `/alias/${uuid}`, { alias }),
    clearAlias: (uuid: string) => request<{ removed: boolean }>("DELETE", `/alias/${uuid}`),
    setPassword: (uuid: string, password: string) => request<{ changed: boolean }>("POST", `/password/${uuid}`, { password }),
    streams: () => request<{ streams: StreamEntry[] }>("GET", "/streams"),
    addStream: (name: string, url: string) => request<{ stream: StreamEntry }>("POST", "/streams", { name, url }),
    editStream: (id: string, name: string, url: string) => request<{ rewritten: number }>("PUT", `/streams/${id}`, { name, url }),
    deleteStream: (id: string) => request<{ deleted: boolean }>("DELETE", `/streams/${id}`),
  };
}

export type JellyfinAdminApi = ReturnType<typeof useJellyfinAdminApi>;

export function when(value: number | string | null | undefined): string {
  if (!value) return "—";
  const ms = typeof value === "number" ? value : Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(ms)) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
  return new Date(ms).toLocaleDateString();
}

/** The same alphabet the configuration page uses for client passwords. */
export function newClientPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

/** Mirrors the server's slug, so the suggested alias matches what it would pick. */
export function aliasFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug.length >= 3 ? slug : `${slug || "jf"}-home`.slice(0, 32);
}
