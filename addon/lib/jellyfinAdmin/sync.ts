import consola from 'consola';
import { getManaged, subsOf, upsertManaged, type ManagedEntry } from './store';
import { buildSubConfig, sameConfig } from './inherit';

const database: any = require('../database');

const logger = consola.withTag('JellyfinAdmin');

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

/** Configurations this module is writing right now, so their own save hook stays quiet. */
const writing = new Set<string>();
const lastReports = new Map<string, SyncReport>();

export function lastSyncReport(masterUuid: string): SyncReport | null {
  return lastReports.get(masterUuid) ?? null;
}

/** Writes a configuration under the hash it already has, without waking the hook for it. */
export async function writeConfig(uuid: string, config: any): Promise<any> {
  const user = await database.getUser(uuid);
  if (!user) throw new Error('Configuration not found');
  writing.add(uuid);
  try {
    return await database.saveUserConfig(uuid, user.password_hash, {
      ...config,
      lastModified: Date.now(),
      configVersion: Date.now(),
    });
  } finally {
    writing.delete(uuid);
  }
}

/** Rebuilds one sub from its master; writes only when something changed. */
export async function applyToSub(entry: ManagedEntry, master: any): Promise<SyncResult> {
  try {
    const current = await database.getUserConfig(entry.uuid);
    if (!current) return { uuid: entry.uuid, name: entry.name, ok: false, error: 'Configuration not found' };

    const built = buildSubConfig(master, current, entry.inherited);
    const changed = !sameConfig(built.config, current);
    if (changed) await writeConfig(entry.uuid, built.config);
    if (JSON.stringify(built.inherited) !== JSON.stringify(entry.inherited)) {
      await upsertManaged({ ...entry, inherited: built.inherited });
    }
    return { uuid: entry.uuid, name: entry.name, ok: true, changed };
  } catch (error: any) {
    logger.warn(`Updating sub ${entry.uuid} from its master failed: ${error.message}`);
    return { uuid: entry.uuid, name: entry.name, ok: false, error: error.message };
  }
}

export async function syncMaster(masterUuid: string): Promise<SyncReport> {
  const master = await database.getUserConfig(masterUuid);
  const results: SyncResult[] = [];
  if (master) {
    for (const sub of await subsOf(masterUuid)) {
      results.push(await applyToSub(sub, master));
    }
  }
  const report = { at: Date.now(), results };
  lastReports.set(masterUuid, report);
  const failed = results.filter((r) => !r.ok).length;
  if (results.length) logger.info(`Master ${masterUuid} passed to ${results.length - failed} of ${results.length} subs`);
  return report;
}

/**
 * Called after every configuration save. A master hands its changes to its subs;
 * a sub saved from anywhere else is rebuilt, so a switch turned on for a
 * credential it only borrowed is turned off again.
 */
export async function afterConfigSaved(uuid: string): Promise<void> {
  if (writing.has(uuid)) return;
  const entry = await getManaged(uuid);
  if (!entry) return;

  if (entry.kind === 'master') {
    await syncMaster(uuid);
    return;
  }

  if (entry.masterUuid) {
    // The caller caches what it just saved once the save returns; rebuilding after that keeps the cache from holding the unguarded copy.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const master = await database.getUserConfig(entry.masterUuid);
    if (master) await applyToSub(entry, master);
  }
}
