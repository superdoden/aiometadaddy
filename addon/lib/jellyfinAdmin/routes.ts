import consola from 'consola';
import { allConfigs, deleteJellyfinState, deleteManaged, getManaged, listManaged, subsOf, upsertManaged } from './store';
import { buildSubConfig } from './inherit';
import { applyToSub, lastSyncReport, syncMaster, writeConfig } from './sync';
import { createStream, editStream, isStreamUrl, removeStream, streamsWithUsage } from './streams';

const database: any = require('../database');
const { getSetting } = require('../settingsService');
const aliases: any = require('../aliasResolver');

const logger = consola.withTag('JellyfinAdmin');

export const PREFIX = '/api/dashboard/jellyfin-admin';

const MAX_NAME = 64;

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_NAME) : '';
}

function cleanPassword(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** "Familie Meier" → "familie-meier"; padded when too short to be an alias. */
export function aliasFromName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug.length >= 3 ? slug : `${slug || 'jf'}-home`.slice(0, 32);
}

function hasJellyfin(config: any): boolean {
  return Boolean(
    (Array.isArray(config?.jellyfinUsers) && config.jellyfinUsers.length) ||
    config?.jellyfinStreamUrl ||
    config?.jellyfinAppPassword ||
    config?.jellyfinUserName
  );
}

function usersOf(config: any): Array<{ id: string; name: string; main?: boolean }> {
  const main = config?.jellyfinUserName || config?.addonName || '';
  const out: Array<{ id: string; name: string; main?: boolean }> = [{ id: '', name: main, main: true }];
  for (const user of Array.isArray(config?.jellyfinUsers) ? config.jellyfinUsers : []) {
    if (typeof user?.id === 'string' && typeof user?.name === 'string') out.push({ id: user.id, name: user.name });
  }
  return out;
}

/** Last sign-in and last play per configuration and user, from the tables the server keeps anyway. */
async function activity(): Promise<Map<string, { signIn: Record<string, number>; play: Record<string, number> }>> {
  const out = new Map<string, { signIn: Record<string, number>; play: Record<string, number> }>();
  const slot = (uuid: string) => {
    if (!out.has(uuid)) out.set(uuid, { signIn: {}, play: {} });
    return out.get(uuid)!;
  };
  const tokens = await database.allQuery('SELECT user_uuid, profile_id, MAX(last_used_at) AS at FROM jellyfin_tokens GROUP BY user_uuid, profile_id').catch(() => []);
  for (const row of tokens) slot(row.user_uuid).signIn[row.profile_id || ''] = Number(row.at) || 0;
  const plays = await database.allQuery('SELECT user_uuid, profile, MAX(updated_at) AS at FROM jellyfin_playstate GROUP BY user_uuid, profile').catch(() => []);
  for (const row of plays) slot(row.user_uuid).play[row.profile || ''] = Number(row.at) || 0;
  return out;
}

function fail(res: any, error: any, fallback: string) {
  const status = Number(error?.status) || 500;
  if (status >= 500) logger.error(`${fallback}:`, error);
  res.status(status).json({ error: status >= 500 ? fallback : error.message });
}

async function requireConfig(uuid: string): Promise<any> {
  const config = await database.getUserConfig(uuid);
  if (!config) throw Object.assign(new Error('Configuration not found'), { status: 404 });
  return config;
}

async function setAlias(uuid: string, alias: string): Promise<string> {
  const result = await aliases.setAliasForUser(uuid, alias);
  if (!result.ok) throw Object.assign(new Error(result.error || 'Alias rejected'), { status: result.status || 400 });
  return result.alias;
}

/** A free alias near the wanted one: "familie-meier", then "familie-meier-2", and so on. */
async function claimAlias(uuid: string, wanted: string): Promise<string> {
  for (let n = 1; n <= 20; n += 1) {
    const candidate = n === 1 ? wanted : `${wanted.slice(0, 29)}-${n}`;
    const owner = aliases.resolveAliasSync(candidate.toLowerCase());
    if (owner && owner !== uuid) continue;
    return setAlias(uuid, candidate);
  }
  throw Object.assign(new Error('No free alias found for that name'), { status: 409 });
}

export function registerJellyfinAdminRoutes(addon: any, requireDashboardAdmin: any): void {
  const route = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, handler: (req: any, res: any) => Promise<void>, failure: string) => {
    addon[method](`${PREFIX}${path}`, requireDashboardAdmin, async (req: any, res: any) => {
      try {
        await handler(req, res);
      } catch (error: any) {
        fail(res, error, failure);
      }
    });
  };

  route('get', '/overview', async (req, res) => {
    const [configs, managed, seen] = await Promise.all([allConfigs(), listManaged(), activity()]);
    const managedBy = new Map(managed.map((m) => [m.uuid, m]));
    const streams: Array<{ url: string; name: string }> = await streamsWithUsage().catch(() => []);
    const streamName = new Map<string, string>(streams.map((s) => [s.url, s.name]));

    res.json({
      jellyfinEnabled: String(getSetting('JELLYFIN_API_ENABLED') || '').trim().toLowerCase() === 'true',
      aliasesEnabled: aliases.isAliasFeatureEnabled(),
      baseUrl: require('../installUrl').baseUrlFrom(process.env.HOST_NAME, req.get('host')),
      configs: configs.map(({ uuid, config, createdAt, updatedAt }) => {
        const entry = managedBy.get(uuid);
        const act = seen.get(uuid);
        return {
          uuid,
          alias: aliases.getAliasForUuid(uuid),
          name: entry?.name || config.addonName || null,
          addonName: config.addonName || null,
          kind: entry?.kind ?? null,
          masterUuid: entry?.masterUuid ?? null,
          hasJellyfin: hasJellyfin(config),
          catalogCount: Array.isArray(config.catalogs) ? config.catalogs.filter((c: any) => c?.enabled).length : 0,
          streamUrl: config.jellyfinStreamUrl || null,
          streamName: config.jellyfinStreamUrl ? streamName.get(String(config.jellyfinStreamUrl).trim()) ?? null : null,
          users: usersOf(config).map((u) => ({
            ...u,
            lastSignIn: act?.signIn[u.id] ?? null,
            lastPlay: act?.play[u.id] ?? null,
          })),
          createdAt,
          updatedAt,
        };
      }),
      lastSync: Object.fromEntries(managed.filter((m) => m.kind === 'master').map((m) => [m.uuid, lastSyncReport(m.uuid)])),
    });
  }, 'Failed to load Jellyfin configurations');

  // A master is a copy of a configuration, without its Jellyfin server.
  route('post', '/masters', async (req, res) => {
    const sourceUuid = String(req.body?.sourceUuid ?? '');
    const name = cleanName(req.body?.name);
    const password = cleanPassword(req.body?.password);
    if (!name) throw Object.assign(new Error('A name is required'), { status: 400 });
    if (password.length < 4) throw Object.assign(new Error('The password needs at least 4 characters'), { status: 400 });
    const source = await requireConfig(sourceUuid);

    const copy: any = {};
    for (const [key, value] of Object.entries(JSON.parse(JSON.stringify(source)))) {
      if (!key.startsWith('jellyfin') && key !== 'configHash') copy[key] = value;
    }
    const uuid = database.generateUserUUID();
    await database.saveUserConfig(uuid, await database.hashPassword(password), { ...copy, configVersion: Date.now(), lastModified: Date.now() });
    await database.trustUUID(uuid).catch(() => undefined);
    const entry = await upsertManaged({ uuid, kind: 'master', name, masterUuid: null, inherited: {} });
    logger.info(`Master "${name}" (${uuid}) copied from ${sourceUuid}`);
    res.json({ master: entry });
  }, 'Failed to create the master');

  // A sub is its master plus a Jellyfin server of its own.
  route('post', '/masters/:uuid/subs', async (req, res) => {
    const masterUuid = String(req.params.uuid);
    const master = await getManaged(masterUuid);
    if (master?.kind !== 'master') throw Object.assign(new Error('Not a master'), { status: 404 });
    const masterConfig = await requireConfig(masterUuid);

    const name = cleanName(req.body?.name);
    const password = cleanPassword(req.body?.password);
    const clientPassword = cleanPassword(req.body?.clientPassword).trim();
    const wantedAlias = typeof req.body?.alias === 'string' && req.body.alias.trim() ? req.body.alias.trim() : aliasFromName(name);
    if (!name) throw Object.assign(new Error('A name is required'), { status: 400 });
    if (password.length < 4) throw Object.assign(new Error('The password needs at least 4 characters'), { status: 400 });

    const seed: any = { jellyfinUserName: name };
    if (clientPassword) seed.jellyfinAppPassword = clientPassword;
    const streamUrl = typeof req.body?.streamUrl === 'string' ? req.body.streamUrl.trim() : '';
    if (streamUrl) seed.jellyfinStreamUrl = streamUrl;

    const built = buildSubConfig(masterConfig, seed, {});
    const uuid = database.generateUserUUID();
    const entry = { uuid, kind: 'sub' as const, name, masterUuid, inherited: built.inherited };
    // Registered first, so the save hook already treats it as a sub.
    await upsertManaged(entry);
    try {
      await database.saveUserConfig(uuid, await database.hashPassword(password), { ...built.config, configVersion: Date.now(), lastModified: Date.now() });
    } catch (error) {
      await deleteManaged(uuid);
      throw error;
    }
    await database.trustUUID(uuid).catch(() => undefined);

    let alias: string | null = null;
    let aliasError: string | null = null;
    try {
      alias = req.body?.alias ? await setAlias(uuid, wantedAlias) : await claimAlias(uuid, wantedAlias);
    } catch (error: any) {
      aliasError = error.message;
    }
    logger.info(`Sub "${name}" (${uuid}) created under ${masterUuid}`);
    res.json({ sub: entry, alias, aliasError });
  }, 'Failed to create the sub');

  route('post', '/masters/:uuid/sync', async (req, res) => {
    const master = await getManaged(String(req.params.uuid));
    if (master?.kind !== 'master') throw Object.assign(new Error('Not a master'), { status: 404 });
    res.json(await syncMaster(master.uuid));
  }, 'Failed to update the subs');

  route('patch', '/managed/:uuid', async (req, res) => {
    const entry = await getManaged(String(req.params.uuid));
    if (!entry) throw Object.assign(new Error('Not managed here'), { status: 404 });
    const name = cleanName(req.body?.name);
    if (!name) throw Object.assign(new Error('A name is required'), { status: 400 });
    res.json({ entry: await upsertManaged({ ...entry, name }) });
  }, 'Failed to rename');

  route('delete', '/managed/:uuid', async (req, res) => {
    const uuid = String(req.params.uuid);
    const entry = await getManaged(uuid);
    if (!entry) throw Object.assign(new Error('Not managed here'), { status: 404 });
    if (entry.kind === 'master' && (await subsOf(uuid)).length) {
      throw Object.assign(new Error('Delete or move its subs first'), { status: 409 });
    }
    await database.deleteUser(uuid);
    await deleteJellyfinState(uuid);
    await deleteManaged(uuid);
    logger.info(`${entry.kind === 'master' ? 'Master' : 'Sub'} "${entry.name}" (${uuid}) deleted`);
    res.json({ deleted: true });
  }, 'Failed to delete');

  // Adopts an existing configuration as a sub of a master, or moves a sub to another master.
  route('post', '/managed/:uuid/assign', async (req, res) => {
    const uuid = String(req.params.uuid);
    const masterUuid = String(req.body?.masterUuid ?? '');
    const master = await getManaged(masterUuid);
    if (master?.kind !== 'master') throw Object.assign(new Error('Not a master'), { status: 404 });
    if (uuid === masterUuid) throw Object.assign(new Error('A master cannot be its own sub'), { status: 400 });
    const current = await getManaged(uuid);
    if (current?.kind === 'master') throw Object.assign(new Error('A master cannot become a sub'), { status: 409 });
    const config = await requireConfig(uuid);
    const name = cleanName(req.body?.name) || current?.name || config.jellyfinUserName || config.addonName || uuid.slice(0, 8);
    const entry = await upsertManaged({ uuid, kind: 'sub', name, masterUuid, inherited: current?.inherited ?? {} });
    const result = await applyToSub(entry, await requireConfig(masterUuid));
    res.json({ entry, result });
  }, 'Failed to assign');

  route('get', '/config/:uuid', async (req, res) => {
    const uuid = String(req.params.uuid);
    const config = await requireConfig(uuid);
    res.json({ config, configVersion: Number(config.configVersion) || 0, alias: aliases.getAliasForUuid(uuid), managed: await getManaged(uuid) });
  }, 'Failed to load the configuration');

  route('put', '/config/:uuid', async (req, res) => {
    const uuid = String(req.params.uuid);
    const incoming = req.body?.config;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw Object.assign(new Error('A configuration is required'), { status: 400 });
    const stored = await requireConfig(uuid);
    const base = Number(req.body?.baseVersion);
    if (Number.isFinite(base) && req.body?.force !== true && (Number(stored.configVersion) || 0) > base) {
      res.status(409).json({ error: 'This configuration was changed elsewhere after it was opened.', code: 'CONFIG_CHANGED', configVersion: stored.configVersion });
      return;
    }

    let next = incoming;
    const entry = await getManaged(uuid);
    if (entry?.kind === 'sub' && entry.masterUuid) {
      const built = buildSubConfig(await requireConfig(entry.masterUuid), incoming, entry.inherited);
      next = built.config;
      if (JSON.stringify(built.inherited) !== JSON.stringify(entry.inherited)) await upsertManaged({ ...entry, inherited: built.inherited });
    }
    const persisted = await writeConfig(uuid, next);
    // A master saved here passes on like one saved from the configuration page.
    if (entry?.kind === 'master') await syncMaster(uuid);
    res.json({ config: persisted, configVersion: Number(persisted?.configVersion) || 0 });
  }, 'Failed to save the configuration');

  route('put', '/alias/:uuid', async (req, res) => {
    const uuid = String(req.params.uuid);
    await requireConfig(uuid);
    res.json({ alias: await setAlias(uuid, String(req.body?.alias ?? '')) });
  }, 'Failed to set the alias');

  route('delete', '/alias/:uuid', async (req, res) => {
    res.json({ removed: await aliases.clearAliasForUser(String(req.params.uuid)) });
  }, 'Failed to remove the alias');

  route('post', '/password/:uuid', async (req, res) => {
    const uuid = String(req.params.uuid);
    const password = cleanPassword(req.body?.password);
    if (password.length < 4) throw Object.assign(new Error('The password needs at least 4 characters'), { status: 400 });
    await requireConfig(uuid);
    if (!(await database.resetUserPassword(uuid, password))) throw new Error('Password not changed');
    await require('../configCache').del(uuid).catch(() => undefined);
    res.json({ changed: true });
  }, 'Failed to change the password');

  route('get', '/streams', async (_req, res) => {
    res.json({ streams: await streamsWithUsage() });
  }, 'Failed to load the stream addons');

  route('post', '/streams', async (req, res) => {
    const name = cleanName(req.body?.name);
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!name || !isStreamUrl(url)) throw Object.assign(new Error('A name and an http(s) address are required'), { status: 400 });
    res.json({ stream: await createStream(name, url) });
  }, 'Failed to add the stream addon');

  route('put', '/streams/:id', async (req, res) => {
    const name = cleanName(req.body?.name);
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!name || !isStreamUrl(url)) throw Object.assign(new Error('A name and an http(s) address are required'), { status: 400 });
    res.json(await editStream(String(req.params.id), name, url));
  }, 'Failed to change the stream addon');

  route('delete', '/streams/:id', async (req, res) => {
    await removeStream(String(req.params.id));
    res.json({ deleted: true });
  }, 'Failed to delete the stream addon');
}
