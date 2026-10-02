import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useJellyfinAdminApi, when, type Overview, type OverviewConfig } from "./api";

function labelOf(c: OverviewConfig): string {
  return c.name || c.addonName || c.uuid.slice(0, 8);
}

/** Jellyfin admin (fork): every configuration with a Jellyfin server and the users under it. */
export function JellyfinConfigsCard({ onPick }: { onPick: (uuid: string) => void }) {
  const api = useJellyfinAdminApi();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setOverview(await api.overview());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Reloaded when the admin key changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.adminKey]);

  const rows = useMemo(() => {
    if (!overview) return [];
    const masters = new Map(overview.configs.filter((c) => c.kind === "master").map((c) => [c.uuid, labelOf(c)]));
    const q = filter.trim().toLowerCase();
    return overview.configs
      .filter((c) => c.hasJellyfin || c.kind === "sub")
      .filter((c) => !q
        || c.uuid.startsWith(q)
        || labelOf(c).toLowerCase().includes(q)
        || (c.alias ?? "").toLowerCase().includes(q)
        || c.users.some((u) => u.name.toLowerCase().includes(q)))
      .map((c) => ({ config: c, master: c.masterUuid ? masters.get(c.masterUuid) ?? c.masterUuid.slice(0, 8) : null }))
      .sort((a, b) => (a.master ?? "~").localeCompare(b.master ?? "~") || labelOf(a.config).localeCompare(labelOf(b.config)));
  }, [overview, filter]);

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">All Jellyfin configurations</CardTitle>
            <CardDescription>
              Every configuration with a Jellyfin server, its users and when each last signed in and played. Masters, subs and passwords are managed under Users → Jellyfin Users.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label="Refresh" disabled={loading} onClick={() => void load()}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
        <div className="relative max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, alias, id or user" className="pl-8" />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {error ? <p className="px-4 py-3 text-xs text-destructive">{error}</p> : null}
        {!overview && !error ? <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div> : null}
        {overview && rows.length === 0 ? <p className="px-4 py-3 text-xs text-muted-foreground">No configuration has a Jellyfin server yet.</p> : null}
        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b border-white/[0.06]">
                  <th className="px-4 py-2 font-medium">Configuration</th>
                  <th className="px-2 py-2 font-medium">Master</th>
                  <th className="px-2 py-2 font-medium">Address</th>
                  <th className="px-2 py-2 font-medium">Users</th>
                  <th className="px-2 py-2 font-medium">Stream</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ config: c, master }) => (
                  <tr key={c.uuid} className="border-b border-white/[0.04] align-top">
                    <td className="px-4 py-2">
                      <div className="font-medium">{labelOf(c)}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{c.uuid}</div>
                    </td>
                    <td className="px-2 py-2">{master ?? <span className="text-muted-foreground">{c.kind === "master" ? "is a master" : "—"}</span>}</td>
                    <td className="px-2 py-2 font-mono">{(overview?.aliasesEnabled && c.alias) || <span className="text-muted-foreground">{c.alias ? `${c.alias} (off)` : "id"}</span>}</td>
                    <td className="px-2 py-2">
                      <div className="space-y-0.5">
                        {c.users.map((u) => (
                          <div key={u.id || "main"} className="flex flex-wrap items-center gap-x-2">
                            <span className={cn(u.main && "text-primary")}>{u.name || "Unnamed"}</span>
                            <span className="text-[11px] text-muted-foreground">signed in {when(u.lastSignIn)} · played {when(u.lastPlay)}</span>
                          </div>
                        ))}
                      </div>
                    </td>
                    <td className="px-2 py-2">{c.streamName ? <Badge variant="outline" className="text-[10px]">{c.streamName}</Badge> : c.streamUrl ? "custom" : <span className="text-amber-400">none</span>}</td>
                    <td className="px-4 py-2 text-right">
                      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => onPick(c.uuid)}>Playback</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
