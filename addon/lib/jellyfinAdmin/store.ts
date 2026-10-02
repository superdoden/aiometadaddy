import consola from 'consola';

const database: any = require('../database');

const logger = consola.withTag('JellyfinAdmin');

export type ManagedKind = 'master' | 'sub';

export interface ManagedEntry {
  uuid: string;
  kind: ManagedKind;
  name: string;
  /** Set for a sub: the master its catalogs and settings come from. */
  masterUuid: string | null;
  /** Tracker credentials a sub was handed by its master, by apiKeys key, so its own can be told apart. */
  inherited: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface StreamEntry {
  id: string;
  name: string;
  url: string;
  createdAt: number;
  updatedAt: number;
}

let ready: Promise<void> | null = null;
let managedCache: Map<string, ManagedEntry> | null = null;

/** Both dialects take `?` here; Postgres gets them numbered. */
function sql(query: string): string {
  if (database.type === 'sqlite') return query;
  let n = 0;
  return query.replace(/\?/g, () => `$${++n}`);
}

/** Kept out of the shared schema so an upstream merge never touches it. */
export function ensureTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await database.runQuery(`CREATE TABLE IF NOT EXISTS jfa_managed (
        uuid VARCHAR(255) PRIMARY KEY,
        kind VARCHAR(16) NOT NULL,
        name TEXT NOT NULL,
        master_uuid VARCHAR(255),
        inherited TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`);
      await database.runQuery(`CREATE INDEX IF NOT EXISTS idx_jfa_managed_master ON jfa_managed(master_uuid)`);
      await database.runQuery(`CREATE TABLE IF NOT EXISTS jfa_stream_urls (
        id VARCHAR(64) PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`);
      await database.runQuery(`CREATE TABLE IF NOT EXISTS jfa_meta (
        key VARCHAR(64) PRIMARY KEY,
        value TEXT NOT NULL
      )`);
    })().catch((error) => {
      ready = null;
      logger.error(`Creating the Jellyfin admin tables failed: ${error.message}`);
      throw error;
    });
  }
  return ready;
}

function parseInherited(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function toEntry(row: any): ManagedEntry {
  return {
    uuid: row.uuid,
    kind: row.kind === 'master' ? 'master' : 'sub',
    name: row.name,
    masterUuid: row.master_uuid || null,
    inherited: parseInherited(row.inherited),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

async function loadManaged(): Promise<Map<string, ManagedEntry>> {
  if (managedCache) return managedCache;
  await ensureTables();
  const rows = await database.allQuery('SELECT * FROM jfa_managed');
  managedCache = new Map(rows.map((row: any) => [row.uuid, toEntry(row)]));
  return managedCache;
}

export async function listManaged(): Promise<ManagedEntry[]> {
  return [...(await loadManaged()).values()];
}

export async function getManaged(uuid: string): Promise<ManagedEntry | null> {
  return (await loadManaged()).get(uuid) ?? null;
}

export async function subsOf(masterUuid: string): Promise<ManagedEntry[]> {
  return (await listManaged()).filter((e) => e.kind === 'sub' && e.masterUuid === masterUuid);
}

export async function upsertManaged(entry: Omit<ManagedEntry, 'createdAt' | 'updatedAt'> & { createdAt?: number }): Promise<ManagedEntry> {
  await ensureTables();
  const now = Date.now();
  const existing = await getManaged(entry.uuid);
  const createdAt = existing?.createdAt ?? entry.createdAt ?? now;
  const inherited = JSON.stringify(entry.inherited ?? {});
  if (existing) {
    await database.runQuery(
      sql('UPDATE jfa_managed SET kind = ?, name = ?, master_uuid = ?, inherited = ?, updated_at = ? WHERE uuid = ?'),
      [entry.kind, entry.name, entry.masterUuid, inherited, now, entry.uuid]
    );
  } else {
    await database.runQuery(
      sql('INSERT INTO jfa_managed (uuid, kind, name, master_uuid, inherited, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      [entry.uuid, entry.kind, entry.name, entry.masterUuid, inherited, createdAt, now]
    );
  }
  const saved: ManagedEntry = { ...entry, inherited: entry.inherited ?? {}, createdAt, updatedAt: now };
  (await loadManaged()).set(entry.uuid, saved);
  return saved;
}

export async function deleteManaged(uuid: string): Promise<void> {
  await ensureTables();
  await database.runQuery(sql('DELETE FROM jfa_managed WHERE uuid = ?'), [uuid]);
  (await loadManaged()).delete(uuid);
}

// --- Stream addon list ---

function toStream(row: any): StreamEntry {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export async function listStreams(): Promise<StreamEntry[]> {
  await ensureTables();
  const rows = await database.allQuery('SELECT * FROM jfa_stream_urls ORDER BY name');
  return rows.map(toStream);
}

export async function getStream(id: string): Promise<StreamEntry | null> {
  await ensureTables();
  const row = await database.getQuery(sql('SELECT * FROM jfa_stream_urls WHERE id = ?'), [id]);
  return row ? toStream(row) : null;
}

export async function insertStream(id: string, name: string, url: string): Promise<StreamEntry> {
  await ensureTables();
  const now = Date.now();
  await database.runQuery(
    sql('INSERT INTO jfa_stream_urls (id, name, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
    [id, name, url, now, now]
  );
  return { id, name, url, createdAt: now, updatedAt: now };
}

export async function updateStream(id: string, name: string, url: string): Promise<void> {
  await ensureTables();
  await database.runQuery(
    sql('UPDATE jfa_stream_urls SET name = ?, url = ?, updated_at = ? WHERE id = ?'),
    [name, url, Date.now(), id]
  );
}

export async function deleteStream(id: string): Promise<void> {
  await ensureTables();
  await database.runQuery(sql('DELETE FROM jfa_stream_urls WHERE id = ?'), [id]);
}

export async function getMeta(key: string): Promise<string | null> {
  await ensureTables();
  const row = await database.getQuery(sql('SELECT value FROM jfa_meta WHERE key = ?'), [key]);
  return row ? String(row.value) : null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await ensureTables();
  await database.runQuery(sql('DELETE FROM jfa_meta WHERE key = ?'), [key]);
  await database.runQuery(sql('INSERT INTO jfa_meta (key, value) VALUES (?, ?)'), [key, value]);
}

/** Every stored configuration, parsed; unreadable rows are skipped. */
export async function allConfigs(): Promise<Array<{ uuid: string; config: any; createdAt: any; updatedAt: any }>> {
  const rows = await database.allQuery('SELECT user_uuid, config_data, created_at, updated_at FROM user_configs');
  const out: Array<{ uuid: string; config: any; createdAt: any; updatedAt: any }> = [];
  for (const row of rows) {
    try {
      const config = typeof row.config_data === 'string' ? JSON.parse(row.config_data) : row.config_data;
      if (config && typeof config === 'object') out.push({ uuid: row.user_uuid, config, createdAt: row.created_at, updatedAt: row.updated_at });
    } catch {
      // A config that cannot be parsed is not one the admin can manage here.
    }
  }
  return out;
}

/** Jellyfin state lives in tables keyed by the configuration; not every one of them has the column. */
const JELLYFIN_USER_TABLES = [
  'jellyfin_playstate', 'jellyfin_preferences', 'jellyfin_watchlist', 'jellyfin_favourites',
  'jellyfin_dropped', 'jellyfin_ratings', 'jellyfin_tracker_mirror', 'jellyfin_tracker_sync',
  'jellyfin_watch_index', 'jellyfin_watch_series', 'jellyfin_watch_summary', 'tracker_outbox',
];

export async function deleteJellyfinState(uuid: string): Promise<void> {
  for (const table of JELLYFIN_USER_TABLES) {
    await database.runQuery(sql(`DELETE FROM ${table} WHERE user_uuid = ?`), [uuid]).catch(() => undefined);
  }
}
