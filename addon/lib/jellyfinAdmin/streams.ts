import { randomBytes } from 'crypto';
import consola from 'consola';
import { allConfigs, deleteStream, deleteStreams, getMeta, getStream, insertStream, listStreams, setMeta, updateStream, type StreamEntry } from './store';
import { writeConfig } from './sync';

const logger = consola.withTag('JellyfinAdmin');

/**
 * The list is a catalog of stream addon addresses. A configuration does not point
 * at an entry; it holds the address itself, as it always did, and an entry is in
 * use wherever its address appears. Changing an entry's address rewrites it in
 * every configuration that holds the old one.
 */

function cleanUrl(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Every stream address a configuration holds: its own and each user's. */
export function streamUrlsOf(config: any): string[] {
  const out: string[] = [];
  const own = cleanUrl(config?.jellyfinStreamUrl);
  if (own) out.push(own);
  for (const user of Array.isArray(config?.jellyfinUsers) ? config.jellyfinUsers : []) {
    const url = cleanUrl(user?.streamUrl);
    if (url) out.push(url);
  }
  return out;
}

export function isStreamUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function newId(): string {
  return randomBytes(8).toString('hex');
}

type Configs = Array<{ config: any }>;

let importing: Promise<void> | null = null;

/** Once: every address already in a configuration becomes an entry. Concurrent callers share one run. */
function importExisting(configs?: Configs): Promise<void> {
  if (!importing) {
    importing = (async () => {
      if (await getMeta('streams_imported')) return;
      const known = new Set((await listStreams()).map((s) => s.url));
      let n = known.size;
      for (const { config } of configs ?? await allConfigs()) {
        for (const url of streamUrlsOf(config)) {
          if (known.has(url)) continue;
          known.add(url);
          n += 1;
          await insertStream(newId(), `AIOStreams ${n}`, url);
        }
      }
      await setMeta('streams_imported', String(Date.now()));
      logger.info(`Stream list started with ${n} addresses from existing configurations`);
    })().catch((error) => {
      importing = null;
      throw error;
    });
  }
  return importing;
}

/** One entry per address; extra copies (from an import that once ran twice) are removed, oldest kept. */
async function uniqueStreams(): Promise<StreamEntry[]> {
  const all = (await listStreams()).sort((a, b) => a.createdAt - b.createdAt);
  const seen = new Set<string>();
  const extra: string[] = [];
  const kept = all.filter((s) => {
    if (seen.has(s.url)) {
      extra.push(s.id);
      return false;
    }
    seen.add(s.url);
    return true;
  });
  if (extra.length) await deleteStreams(extra);
  return kept.sort((a, b) => a.name.localeCompare(b.name));
}

/** Pass the configurations when they are already loaded, to read the table once. */
export async function streamsWithUsage(configs?: Configs): Promise<Array<StreamEntry & { usage: number }>> {
  const loaded = configs ?? await allConfigs();
  await importExisting(loaded);
  const counts = new Map<string, number>();
  for (const { config } of loaded) {
    for (const url of streamUrlsOf(config)) counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  return (await uniqueStreams()).map((s) => ({ ...s, usage: counts.get(s.url) ?? 0 }));
}

export async function createStream(name: string, url: string): Promise<StreamEntry> {
  await importExisting();
  if ((await uniqueStreams()).some((s) => s.url === url)) throw Object.assign(new Error('That address is already in the list'), { status: 409 });
  return insertStream(newId(), name, url);
}

/** Renames an entry and, when its address changed, rewrites the address wherever it was used. */
export async function editStream(id: string, name: string, url: string): Promise<{ rewritten: number }> {
  const entry = await getStream(id);
  if (!entry) throw Object.assign(new Error('No such entry'), { status: 404 });
  if (url !== entry.url && (await listStreams()).some((s) => s.id !== id && s.url === url)) {
    throw Object.assign(new Error('That address is already in the list'), { status: 409 });
  }
  await updateStream(id, name, url);
  if (url === entry.url) return { rewritten: 0 };

  let rewritten = 0;
  for (const { uuid, config } of await allConfigs()) {
    let touched = false;
    const next = { ...config };
    if (cleanUrl(next.jellyfinStreamUrl) === entry.url) {
      next.jellyfinStreamUrl = url;
      touched = true;
    }
    if (Array.isArray(next.jellyfinUsers)) {
      next.jellyfinUsers = next.jellyfinUsers.map((user: any) => {
        if (cleanUrl(user?.streamUrl) !== entry.url) return user;
        touched = true;
        return { ...user, streamUrl: url };
      });
    }
    if (!touched) continue;
    try {
      await writeConfig(uuid, next);
      rewritten += 1;
    } catch (error: any) {
      logger.warn(`Rewriting the stream address of ${uuid} failed: ${error.message}`);
    }
  }
  return { rewritten };
}

export async function removeStream(id: string): Promise<void> {
  const entry = await getStream(id);
  if (!entry) return;
  const used = (await streamsWithUsage()).find((s) => s.id === id)?.usage ?? 0;
  if (used > 0) throw Object.assign(new Error(`Still used in ${used} place${used === 1 ? '' : 's'}; pick another address there first`), { status: 409 });
  await deleteStream(id);
}
