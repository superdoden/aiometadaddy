import { slotServiceOf } from '../accounts';

/**
 * A tracker the configuration can hold: the credential pointer in apiKeys, the
 * switch that lets plays be read from and written to it, and the fields that
 * describe the signed-in account.
 */
interface TrackerSlot {
  service: string;
  key: string;
  flag: string;
  extras: string[];
}

const TRACKERS: TrackerSlot[] = [
  { service: 'simkl', key: 'simklTokenId', flag: 'simklWatchTracking', extras: ['simklUser', 'simklSyncInterval'] },
  { service: 'mdblist', key: 'mdblist', flag: 'mdblistWatchTracking', extras: [] },
  { service: 'publicmetadb', key: 'publicmetadb', flag: 'publicmetadbWatchTracking', extras: [] },
  { service: 'anilist', key: 'anilistTokenId', flag: 'anilistWatchTracking', extras: [] },
  { service: 'mal', key: 'malTokenId', flag: 'malWatchTracking', extras: [] },
  { service: 'trakt', key: 'traktTokenId', flag: 'traktWatchTracking', extras: ['traktUser'] },
];

/**
 * Bookkeeping a sub always keeps as its own, and the AIOManager/Hydra accounts,
 * which would otherwise let a sub push its install into the master's manager.
 */
const OWN_FIELDS = new Set(['configVersion', 'lastModified', 'configHash', 'sessionId', 'managers', 'managerAccounts']);

/** Marks a credential in the inherited map as the sub's own, even when the master holds the same one. */
const OWN_PREFIX = 'own:';

/** Every tracker credential a configuration holds, marked as its own; for adopting a configuration as a sub. */
export function ownMarkersFor(config: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of TRACKERS) {
    const cred = config?.apiKeys?.[slot.key];
    if (cred) out[`${OWN_PREFIX}${slot.key}`] = cred;
  }
  return out;
}

function isOwnField(key: string): boolean {
  return key.startsWith('jellyfin') || OWN_FIELDS.has(key);
}

function catalogKey(catalog: any): string {
  return `${catalog?.id ?? ''}|${catalog?.type ?? ''}`;
}

export interface BuiltSub {
  config: any;
  /** Credentials taken from the master this time, by apiKeys key, plus `own:` markers for the sub's own. */
  inherited: Record<string, string>;
}

/**
 * A sub is its master with its own Jellyfin settings and users on top.
 *
 * A tracker credential the sub was handed by the master serves the catalogs
 * only: its switch is forced off, so nothing played on the sub is read from or
 * written to the master's accounts. A credential the sub connected itself stays
 * the sub's, switch and all.
 */
export function buildSubConfig(master: any, sub: any | null, previouslyInherited: Record<string, string>): BuiltSub {
  const out: any = {};
  for (const [key, value] of Object.entries(master ?? {})) {
    if (!isOwnField(key)) out[key] = value;
  }
  for (const [key, value] of Object.entries(sub ?? {})) {
    if (isOwnField(key)) out[key] = value;
  }

  const masterKeys = master?.apiKeys ?? {};
  const subKeys = sub?.apiKeys ?? {};
  out.apiKeys = { ...masterKeys };
  out.watchTracking = { ...(master?.watchTracking ?? {}) };
  const inherited: Record<string, string> = {};

  for (const slot of TRACKERS) {
    const masterCred = masterKeys[slot.key] || undefined;
    const subCred = subKeys[slot.key] || undefined;
    const markedOwn = Boolean(subCred) && subCred === previouslyInherited[`${OWN_PREFIX}${slot.key}`];
    const own = markedOwn || (Boolean(subCred) && subCred !== previouslyInherited[slot.key] && subCred !== masterCred);

    if (own) {
      // Remembered, so it stays the sub's if the master later connects the same account.
      inherited[`${OWN_PREFIX}${slot.key}`] = subCred as string;
      out.apiKeys[slot.key] = subCred;
      out[slot.flag] = sub[slot.flag];
      out.watchTracking[slot.service] = sub?.watchTracking?.[slot.service];
      for (const extra of slot.extras) out[extra] = sub[extra];
      continue;
    }

    if (masterCred) {
      out.apiKeys[slot.key] = masterCred;
      out[slot.flag] = false;
      inherited[slot.key] = masterCred;
    } else {
      delete out.apiKeys[slot.key];
      delete out[slot.flag];
      for (const extra of slot.extras) delete out[extra];
    }
  }

  // A list a sub user's own account added keeps its place; everything else is the master's.
  const masterCatalogs: any[] = Array.isArray(master?.catalogs) ? master.catalogs : [];
  const known = new Set(masterCatalogs.map(catalogKey));
  const ownSlots = (Array.isArray(sub?.catalogs) ? sub.catalogs : [])
    .filter((c: any) => !known.has(catalogKey(c)) && slotServiceOf(c) !== null);
  out.catalogs = [...masterCatalogs, ...ownSlots];

  return { config: out, inherited };
}

/** Plain JSON comparison; key order follows the build, so equal builds compare equal. */
export function sameConfig(a: any, b: any): boolean {
  const strip = (c: any) => {
    const { configHash: _h, configVersion: _v, lastModified: _l, ...rest } = c ?? {};
    return rest;
  };
  return stableStringify(strip(a)) === stableStringify(strip(b));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
