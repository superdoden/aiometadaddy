import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, Check, Copy, ExternalLink, KeyRound, Loader2, Pencil, Plus, RefreshCw, Settings2, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { StreamPicker } from "@/components/jellyfin/StreamPicker";
import { AdminJellyfinEditor } from "./AdminJellyfinEditor";
import {
  aliasFromName,
  newClientPassword,
  useJellyfinAdminApi,
  when,
  type JellyfinAdminApi,
  type Overview,
  type OverviewConfig,
  type StreamEntry,
} from "./api";

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Copy failed");
  }
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

function labelOf(c: OverviewConfig): string {
  return c.name || c.addonName || c.uuid.slice(0, 8);
}

function lastActivity(c: OverviewConfig): number | null {
  const times = c.users.flatMap((u) => [u.lastSignIn ?? 0, u.lastPlay ?? 0]);
  const max = Math.max(0, ...times);
  return max || null;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function PasswordInput({ value, onChange, placeholder, generate }: { value: string; onChange: (v: string) => void; placeholder?: string; generate?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Input className="h-8 font-mono text-xs" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {generate ? (
        <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={() => onChange(newClientPassword())}>
          Generate
        </Button>
      ) : null}
    </div>
  );
}

function UserChips({ config }: { config: OverviewConfig }) {
  return (
    <div className="flex flex-wrap gap-1">
      {config.users.map((u) => (
        <span
          key={u.id || "main"}
          title={`Last sign-in: ${when(u.lastSignIn)} · Last play: ${when(u.lastPlay)}`}
          className={cn("rounded-full border px-2 py-0.5 text-[11px]", u.main ? "border-primary/40 text-primary" : "border-white/10 text-muted-foreground")}
        >
          {u.name || "Unnamed"}
        </span>
      ))}
    </div>
  );
}

/** Inline name or alias editing: a value, a pencil, and save/cancel while editing. */
function InlineEdit({ value, onSave, mono, placeholder }: { value: string; onSave: (next: string) => Promise<void>; mono?: boolean; placeholder?: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!editing) setText(value); }, [value, editing]);
  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <span className={cn(mono && "font-mono", !value && "text-muted-foreground")}>{value || placeholder || "—"}</span>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" aria-label="Edit" onClick={() => setEditing(true)}>
          <Pencil className="h-3 w-3" />
        </Button>
      </span>
    );
  }
  const commit = async () => {
    setBusy(true);
    try {
      await onSave(text.trim());
      setEditing(false);
    } catch (e) {
      toast.error(errorText(e, "Not saved"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-1">
      <Input autoFocus className={cn("h-7 w-48 text-xs", mono && "font-mono")} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void commit(); if (e.key === "Escape") setEditing(false); }} />
      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={busy} onClick={() => void commit()} aria-label="Save">
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
      </Button>
      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={busy} onClick={() => setEditing(false)} aria-label="Cancel">
        <X className="h-3 w-3" />
      </Button>
    </span>
  );
}

// --- Masters & subs ---

function NewMasterForm({ api, configs, preset, onCreated, onCancel }: { api: JellyfinAdminApi; configs: OverviewConfig[]; preset?: string; onCreated: (uuid: string) => void; onCancel: () => void }) {
  const [filter, setFilter] = useState("");
  const [source, setSource] = useState(preset ?? "");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const candidates = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return configs
      .filter((c) => c.kind !== "sub")
      .filter((c) => !q || c.uuid.startsWith(q) || labelOf(c).toLowerCase().includes(q) || (c.alias ?? "").toLowerCase().includes(q))
      .slice(0, 50);
  }, [configs, filter]);

  const submit = async () => {
    setBusy(true);
    try {
      const { master } = await api.createMaster(source, name.trim(), password);
      toast.success(`Master "${master.name}" created`);
      onCreated(master.uuid);
    } catch (e) {
      toast.error(errorText(e, "Could not create the master"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">New master</p>
      <Field label="Copy from configuration" hint="Catalogs and settings are copied; its Jellyfin server and users are not. The original stays as it is.">
        <Input className="h-8 text-xs" placeholder="Filter by name, alias or id" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Pick a configuration" /></SelectTrigger>
          <SelectContent>
            {candidates.map((c) => (
              <SelectItem key={c.uuid} value={c.uuid}>
                {labelOf(c)} · {c.alias || c.uuid.slice(0, 8)} · {c.catalogCount} catalogs{c.kind === "master" ? " · master" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input className="h-8 text-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Family" /></Field>
        <Field label="Configuration password" hint="Opens the master on the configuration page, to edit its catalogs.">
          <PasswordInput value={password} onChange={setPassword} generate />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={busy || !source || !name.trim() || password.length < 4} onClick={() => void submit()}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}Create master
        </Button>
      </div>
    </div>
  );
}

function NewSubForm({ api, masterUuid, streams, aliasesEnabled, onCreated, onCancel }: { api: JellyfinAdminApi; masterUuid: string; streams: StreamEntry[]; aliasesEnabled: boolean; onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [aliasTouched, setAliasTouched] = useState(false);
  const [password, setPassword] = useState("");
  const [clientPassword, setClientPassword] = useState(newClientPassword());
  const [streamUrl, setStreamUrl] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const shownAlias = aliasTouched ? alias : name.trim() ? aliasFromName(name) : "";

  const submit = async () => {
    setBusy(true);
    try {
      const result = await api.createSub(masterUuid, {
        name: name.trim(),
        password,
        clientPassword: clientPassword.trim() || undefined,
        streamUrl,
        alias: aliasTouched && alias.trim() ? alias.trim() : undefined,
      });
      toast.success(`Sub "${result.sub.name}" created${result.alias ? ` as ${result.alias}` : ""}`);
      if (result.aliasError) toast.warning(`Alias not set: ${result.aliasError}`);
      onCreated();
    } catch (e) {
      toast.error(errorText(e, "Could not create the sub"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">New sub</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="Also the name of its first Jellyfin user.">
          <Input className="h-8 text-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Familie Meier" />
        </Field>
        <Field label="Alias" hint={aliasesEnabled ? "The server address uses it instead of the id. Taken aliases get a number." : "Aliases are off on this instance (USER_ALIASES_ENABLED); the address uses the id until they are on."}>
          <Input className="h-8 font-mono text-xs" value={shownAlias} onChange={(e) => { setAliasTouched(true); setAlias(e.target.value); }} placeholder="familie-meier" />
        </Field>
        <Field label="Configuration password" hint="For the configuration page. Not shown again; it can be reset.">
          <PasswordInput value={password} onChange={setPassword} generate />
        </Field>
        <Field label="Client password" hint="What the household types into a Jellyfin client. Stays visible in the Jellyfin settings.">
          <PasswordInput value={clientPassword} onChange={setClientPassword} generate />
        </Field>
      </div>
      <Field label="Stream addon">
        <StreamPicker value={streamUrl} options={streams} onChange={setStreamUrl} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={busy || !name.trim() || password.length < 4} onClick={() => void submit()}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}Create sub
        </Button>
      </div>
    </div>
  );
}

function PasswordReset({ api, uuid }: { api: JellyfinAdminApi; uuid: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setOpen(true)}>
        <KeyRound className="mr-1 h-3 w-3" />Password
      </Button>
    );
  }
  const save = async () => {
    setBusy(true);
    try {
      await api.setPassword(uuid, value);
      toast.success("Configuration password changed");
      setOpen(false);
      setValue("");
    } catch (e) {
      toast.error(errorText(e, "Not changed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-1">
      <Input autoFocus className="h-7 w-40 font-mono text-xs" placeholder="New password" value={value} onChange={(e) => setValue(e.target.value)} />
      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={busy || value.length < 4} onClick={() => void save()} aria-label="Save password">
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
      </Button>
      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setOpen(false)} aria-label="Cancel"><X className="h-3 w-3" /></Button>
    </span>
  );
}

function ConfigRow({ api, config, overview, onEdit, onChanged, actions }: { api: JellyfinAdminApi; config: OverviewConfig; overview: Overview; onEdit: (c: OverviewConfig) => void; onChanged: () => void; actions?: ReactNode }) {
  const address = `${overview.baseUrl.replace(/\/+$/, "")}/jellyfin/${(overview.aliasesEnabled && config.alias) || config.uuid}`;
  const isSub = config.kind === "sub";
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {config.kind ? (
            <InlineEdit value={labelOf(config)} onSave={async (next) => { await api.rename(config.uuid, next); onChanged(); }} />
          ) : labelOf(config)}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{config.uuid.slice(0, 8)}</span>
        {config.streamName ? <Badge variant="outline" className="text-[10px]">{config.streamName}</Badge> : config.streamUrl ? <Badge variant="outline" className="text-[10px]">Custom stream</Badge> : <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-400">Browse only</Badge>}
        <span className="ml-auto text-[11px] text-muted-foreground">Active {when(lastActivity(config))}</span>
      </div>
      <UserChips config={config} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {isSub ? (
          <span className="inline-flex items-center gap-1">
            <span className="text-muted-foreground">Alias:</span>
            <InlineEdit
              mono
              value={config.alias ?? ""}
              placeholder="none"
              onSave={async (next) => {
                if (next) await api.setAlias(config.uuid, next);
                else await api.clearAlias(config.uuid);
                onChanged();
              }}
            />
          </span>
        ) : null}
        <span className="inline-flex min-w-0 items-center gap-1">
          <span className="text-muted-foreground">Address:</span>
          <span className="truncate font-mono">{address}</span>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" aria-label="Copy address" onClick={() => void copy(address, "Server address")}>
            <Copy className="h-3 w-3" />
          </Button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t pt-2">
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => onEdit(config)}>
          <Settings2 className="mr-1 h-3 w-3" />Jellyfin settings & users
        </Button>
        <PasswordReset api={api} uuid={config.uuid} />
        {actions}
      </div>
    </div>
  );
}

function MastersTab({ api, overview, streams, onChanged, onEdit, presetSource, clearPreset }: { api: JellyfinAdminApi; overview: Overview; streams: StreamEntry[]; onChanged: () => void; onEdit: (c: OverviewConfig) => void; presetSource: string | null; clearPreset: () => void }) {
  const masters = overview.configs.filter((c) => c.kind === "master");
  const [selected, setSelected] = useState<string | null>(masters[0]?.uuid ?? null);
  const [creatingMaster, setCreatingMaster] = useState(false);
  const [creatingSub, setCreatingSub] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (presetSource) setCreatingMaster(true);
  }, [presetSource]);
  useEffect(() => {
    if (!selected && masters.length) setSelected(masters[0].uuid);
  }, [masters, selected]);

  const master = masters.find((m) => m.uuid === selected) ?? null;
  const subs = overview.configs.filter((c) => c.kind === "sub" && c.masterUuid === selected);
  const report = selected ? overview.lastSync[selected] : null;
  const failed = report?.results.filter((r) => !r.ok) ?? [];

  const sync = async () => {
    if (!master) return;
    setSyncing(true);
    try {
      const result = await api.syncMaster(master.uuid);
      const bad = result.results.filter((r) => !r.ok).length;
      if (bad) toast.warning(`${bad} of ${result.results.length} subs were not updated`);
      else toast.success(`${result.results.length} sub${result.results.length === 1 ? "" : "s"} up to date`);
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Sync failed"));
    } finally {
      setSyncing(false);
    }
  };

  const remove = async (c: OverviewConfig) => {
    const what = c.kind === "master" ? "master" : "sub";
    if (!window.confirm(`Delete the ${what} "${labelOf(c)}"? Its configuration${c.kind === "sub" ? ", Jellyfin users, sign-ins and watch state" : ""} are deleted for good.`)) return;
    try {
      await api.remove(c.uuid);
      toast.success(`Deleted "${labelOf(c)}"`);
      if (c.uuid === selected) setSelected(null);
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Not deleted"));
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Masters</p>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setCreatingMaster(true)}>
            <Plus className="mr-1 h-3 w-3" />New
          </Button>
        </div>
        {masters.length === 0 ? <p className="text-xs text-muted-foreground">No master yet. A master is a copy of a configuration whose catalogs its subs share.</p> : null}
        {masters.map((m) => {
          const count = overview.configs.filter((c) => c.kind === "sub" && c.masterUuid === m.uuid).length;
          return (
            <button
              key={m.uuid}
              type="button"
              onClick={() => { setSelected(m.uuid); setCreatingSub(false); }}
              className={cn("w-full rounded-md border px-3 py-2 text-left text-sm transition hover:bg-muted/40", m.uuid === selected && "border-primary/60 bg-primary/10")}
            >
              <span className="block font-medium">{labelOf(m)}</span>
              <span className="text-[11px] text-muted-foreground">{count} sub{count === 1 ? "" : "s"} · {m.catalogCount} catalogs</span>
            </button>
          );
        })}
      </div>

      <div className="min-w-0 space-y-3">
        {creatingMaster ? (
          <NewMasterForm
            api={api}
            configs={overview.configs}
            preset={presetSource ?? undefined}
            onCancel={() => { setCreatingMaster(false); clearPreset(); }}
            onCreated={(uuid) => { setCreatingMaster(false); clearPreset(); setSelected(uuid); onChanged(); }}
          />
        ) : null}

        {master ? (
          <>
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold">
                  <InlineEdit value={labelOf(master)} onSave={async (next) => { await api.rename(master.uuid, next); onChanged(); }} />
                </span>
                <Badge variant="outline" className="text-[10px]">Master</Badge>
                <span className="font-mono text-[11px] text-muted-foreground">{master.uuid}</span>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" aria-label="Copy id" onClick={() => void copy(master.uuid, "Configuration id")}><Copy className="h-3 w-3" /></Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Catalogs, providers and keys are edited on the configuration page: open it, load this id with the master's password, and save. Every save reaches all subs. Tracker accounts of the master serve the subs' catalogs only; nothing a sub plays is read from or written to them.
              </p>
              <div className="flex flex-wrap items-center gap-1">
                <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs">
                  <a href={`/configure`} target="_blank" rel="noreferrer"><ExternalLink className="mr-1 h-3 w-3" />Configuration page</a>
                </Button>
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={syncing} onClick={() => void sync()}>
                  {syncing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}Update subs now
                </Button>
                <PasswordReset api={api} uuid={master.uuid} />
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive" disabled={subs.length > 0} title={subs.length ? "Delete or move its subs first" : undefined} onClick={() => void remove(master)}>
                  <Trash2 className="mr-1 h-3 w-3" />Delete master
                </Button>
                <span className="ml-auto text-[11px] text-muted-foreground">{report ? `Subs last updated ${when(report.at)}` : "Subs not updated since the server started"}</span>
              </div>
              {failed.length ? (
                <p className="flex items-center gap-1.5 text-xs text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Not updated: {failed.map((r) => `${r.name} (${r.error})`).join(", ")}
                </p>
              ) : null}
            </div>

            <div className="flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Subs</p>
              {!creatingSub ? (
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setCreatingSub(true)}>
                  <Plus className="mr-1 h-3 w-3" />New sub
                </Button>
              ) : null}
            </div>
            {creatingSub ? (
              <NewSubForm
                api={api}
                masterUuid={master.uuid}
                streams={streams}
                aliasesEnabled={overview.aliasesEnabled}
                onCancel={() => setCreatingSub(false)}
                onCreated={() => { setCreatingSub(false); onChanged(); }}
              />
            ) : null}
            {subs.length === 0 && !creatingSub ? <p className="text-xs text-muted-foreground">No subs yet. Each sub is its own Jellyfin server with its own address; its users never see another sub's.</p> : null}
            {subs.map((c) => (
              <ConfigRow
                key={c.uuid}
                api={api}
                config={c}
                overview={overview}
                onEdit={onEdit}
                onChanged={onChanged}
                actions={
                  <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs text-destructive" onClick={() => void remove(c)}>
                    <Trash2 className="mr-1 h-3 w-3" />Delete
                  </Button>
                }
              />
            ))}
          </>
        ) : !creatingMaster ? (
          <p className="text-sm text-muted-foreground">Pick or create a master.</p>
        ) : null}
      </div>
    </div>
  );
}

// --- Other configurations ---

function OthersTab({ api, overview, onChanged, onEdit, onUseAsMaster }: { api: JellyfinAdminApi; overview: Overview; onChanged: () => void; onEdit: (c: OverviewConfig) => void; onUseAsMaster: (uuid: string) => void }) {
  const others = overview.configs.filter((c) => !c.kind && c.hasJellyfin);
  const masters = overview.configs.filter((c) => c.kind === "master");

  const assign = async (c: OverviewConfig, masterUuid: string) => {
    const master = masters.find((m) => m.uuid === masterUuid);
    if (!window.confirm(`Make "${labelOf(c)}" a sub of "${master ? labelOf(master) : "the master"}"? Its catalogs and settings are replaced by the master's; its Jellyfin users, passwords and own tracker accounts stay.`)) return;
    try {
      await api.assign(c.uuid, masterUuid);
      toast.success(`"${labelOf(c)}" is now a sub`);
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Not assigned"));
    }
  };

  if (others.length === 0) return <p className="text-sm text-muted-foreground">Every configuration with a Jellyfin server is a master or a sub.</p>;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Configurations with a Jellyfin server that are neither a master nor a sub. They can be edited here, copied into a master, or attached to one.</p>
      {others.map((c) => (
        <ConfigRow
          key={c.uuid}
          api={api}
          config={c}
          overview={overview}
          onEdit={onEdit}
          onChanged={onChanged}
          actions={
            <>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onUseAsMaster(c.uuid)}>Copy into a master</Button>
              {masters.length ? (
                <Select value="" onValueChange={(v) => void assign(c, v)}>
                  <SelectTrigger className="h-7 w-auto gap-1 px-2 text-xs"><SelectValue placeholder="Attach to master…" /></SelectTrigger>
                  <SelectContent>
                    {masters.map((m) => <SelectItem key={m.uuid} value={m.uuid}>{labelOf(m)}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : null}
            </>
          }
        />
      ))}
    </div>
  );
}

// --- Stream addons ---

function StreamRow({ api, entry, onChanged }: { api: JellyfinAdminApi; entry: StreamEntry; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entry.name);
  const [url, setUrl] = useState(entry.url);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (url.trim() !== entry.url && entry.usage > 0 && !window.confirm(`The address is used in ${entry.usage} place${entry.usage === 1 ? "" : "s"}. Change it there too?`)) return;
    setBusy(true);
    try {
      const result = await api.editStream(entry.id, name.trim(), url.trim());
      toast.success(result.rewritten ? `Saved; ${result.rewritten} configuration${result.rewritten === 1 ? "" : "s"} now use the new address` : "Saved");
      setEditing(false);
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Not saved"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove "${entry.name}" from the list?`)) return;
    try {
      await api.deleteStream(entry.id);
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Not removed"));
    }
  };

  if (editing) {
    return (
      <div className="grid gap-2 rounded-md border p-2 sm:grid-cols-[12rem_1fr_auto]">
        <Input className="h-8 text-xs" value={name} onChange={(e) => setName(e.target.value)} />
        <Input className="h-8 font-mono text-xs" value={url} onChange={(e) => setUrl(e.target.value)} />
        <div className="flex gap-1">
          <Button size="sm" className="h-8" disabled={busy || !name.trim() || !url.trim()} onClick={() => void save()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}</Button>
          <Button variant="ghost" size="sm" className="h-8" onClick={() => { setEditing(false); setName(entry.name); setUrl(entry.url); }}>Cancel</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
      <span className="w-48 shrink-0 truncate text-sm font-medium">{entry.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={entry.url}>{entry.url}</span>
      <Badge variant="outline" className="text-[10px]">{entry.usage} in use</Badge>
      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Edit" onClick={() => setEditing(true)}><Pencil className="h-3 w-3" /></Button>
      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" aria-label="Remove" disabled={entry.usage > 0} title={entry.usage > 0 ? "Still in use" : undefined} onClick={() => void remove()}><Trash2 className="h-3 w-3" /></Button>
    </div>
  );
}

function StreamsTab({ api, streams, onChanged }: { api: JellyfinAdminApi; streams: StreamEntry[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await api.addStream(name.trim(), url.trim());
      setName("");
      setUrl("");
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Not added"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Stream addon addresses, such as AIOStreams install URLs, offered by name wherever a sub or user picks one. The list started with every address already in a configuration. Changing an address changes it everywhere it is used. These addresses often hold keys: only admins see this list.
      </p>
      {streams.map((s) => <StreamRow key={s.id} api={api} entry={s} onChanged={onChanged} />)}
      <div className="grid gap-2 rounded-md border border-dashed p-2 sm:grid-cols-[12rem_1fr_auto]">
        <Input className="h-8 text-xs" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input className="h-8 font-mono text-xs" placeholder="https://…/manifest.json" value={url} onChange={(e) => setUrl(e.target.value)} />
        <Button size="sm" className="h-8" disabled={busy || !name.trim() || !url.trim()} onClick={() => void add()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="mr-1 h-4 w-4" />Add</>}
        </Button>
      </div>
    </div>
  );
}

// --- Dialog ---

export function JellyfinAdminDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const api = useJellyfinAdminApi();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [streams, setStreams] = useState<StreamEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<OverviewConfig | null>(null);
  const [tab, setTab] = useState("masters");
  const [presetSource, setPresetSource] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [o, s] = await Promise.all([api.overview(), api.streams()]);
      setOverview(o);
      setStreams(s.streams);
    } catch (e) {
      toast.error(errorText(e, "Could not load the Jellyfin configurations"));
    } finally {
      setLoading(false);
    }
    // api changes identity with the admin key only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.adminKey]);

  useEffect(() => {
    if (isOpen) void refresh();
  }, [isOpen, refresh]);

  const streamOptions = useMemo(() => streams.map((s) => ({ name: s.name, url: s.url })), [streams]);
  const otherCount = overview?.configs.filter((c) => !c.kind && c.hasJellyfin).length ?? 0;

  return (
    <>
      <Dialog open={isOpen && !editing} onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="max-h-[90vh] w-[min(96vw,72rem)] overflow-y-auto sm:max-w-none">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <img src="/jellyfin_icon.svg" alt="" aria-hidden="true" className="h-5 w-5 object-contain" />
              Jellyfin Users
              <Button variant="ghost" size="sm" className="ml-2 h-7 w-7 p-0" aria-label="Refresh" disabled={loading} onClick={() => void refresh()}>
                <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              </Button>
            </DialogTitle>
            <DialogDescription>
              Masters hold the catalogs; each sub is a Jellyfin server of its own built from a master, with its own users, address and passwords.
            </DialogDescription>
          </DialogHeader>

          {overview && !overview.jellyfinEnabled ? (
            <p className="flex items-center gap-1.5 rounded-md border border-amber-500/40 px-3 py-2 text-xs text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" />The Jellyfin server is off on this instance (JELLYFIN_API_ENABLED); clients cannot sign in until it is on.
            </p>
          ) : null}
          {overview && !overview.aliasesEnabled ? (
            <p className="flex items-center gap-1.5 rounded-md border border-amber-500/40 px-3 py-2 text-xs text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" />Aliases are off (USER_ALIASES_ENABLED in Settings); server addresses use the configuration id until they are on.
            </p>
          ) : null}

          {!overview ? (
            <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="masters">Masters &amp; subs</TabsTrigger>
                <TabsTrigger value="others">Other Jellyfin configs{otherCount ? ` (${otherCount})` : ""}</TabsTrigger>
                <TabsTrigger value="streams">Playback URLs ({streams.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="masters" className="pt-3">
                <MastersTab
                  api={api}
                  overview={overview}
                  streams={streams}
                  onChanged={() => void refresh()}
                  onEdit={setEditing}
                  presetSource={presetSource}
                  clearPreset={() => setPresetSource(null)}
                />
              </TabsContent>
              <TabsContent value="others" className="pt-3">
                <OthersTab api={api} overview={overview} onChanged={() => void refresh()} onEdit={setEditing} onUseAsMaster={(uuid) => { setPresetSource(uuid); setTab("masters"); }} />
              </TabsContent>
              <TabsContent value="streams" className="pt-3">
                <StreamsTab api={api} streams={streams} onChanged={() => void refresh()} />
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      {editing ? (
        <AdminJellyfinEditor
          api={api}
          uuid={editing.uuid}
          alias={overview?.aliasesEnabled ? editing.alias : null}
          streamOptions={streamOptions}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh()}
        />
      ) : null}
    </>
  );
}

export default JellyfinAdminDialog;
