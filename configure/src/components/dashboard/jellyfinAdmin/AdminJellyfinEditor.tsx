import { useCallback, useContext, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import { ConfigContext } from "@/contexts/ConfigContext";
import { SaveContext } from "@/contexts/SaveContext";
import type { AppConfig } from "@/contexts/config";
import { JellyfinDialog } from "@/components/JellyfinDialog";
import type { StreamOption } from "@/components/jellyfin/StreamPicker";
import { setRequestAdminKey } from "@/lib/adminRequestAuth";
import { ApiError, type JellyfinAdminApi } from "./api";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** What Save compares; bookkeeping the server rewrites on every save is left out. */
function fingerprint(config: AppConfig | null): string {
  if (!config) return "";
  const { configHash: _h, configVersion: _v, lastModified: _l, ...rest } = config as AppConfig & Record<string, unknown>;
  return stableStringify(rest);
}

interface AdminJellyfinEditorProps {
  api: JellyfinAdminApi;
  uuid: string;
  alias: string | null;
  streamOptions: StreamOption[];
  onClose: () => void;
  onSaved: () => void;
}

/**
 * The configuration page's Jellyfin dialog, run on another configuration: it
 * reads and writes through the admin routes instead of the page's own config.
 */
export function AdminJellyfinEditor({ api, uuid, alias, streamOptions, onClose, onSaved }: AdminJellyfinEditorProps) {
  const outer = useContext(ConfigContext);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [saved, setSaved] = useState<AppConfig | null>(null);
  const [version, setVersion] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setRequestAdminKey(api.adminKey);
    return () => setRequestAdminKey(null);
  }, [api.adminKey]);

  useEffect(() => {
    let cancelled = false;
    api.loadConfig(uuid)
      .then((loaded) => {
        if (cancelled) return;
        setConfig(loaded.config);
        setSaved(loaded.config);
        setVersion(loaded.configVersion);
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error(e instanceof Error ? e.message : "Could not load the configuration");
        onClose();
      });
    return () => { cancelled = true; };
    // Loaded once per opened configuration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuid]);

  const isDirty = useMemo(() => fingerprint(config) !== fingerprint(saved), [config, saved]);

  const save = useCallback(async (force = false) => {
    if (!config) return;
    setIsSaving(true);
    setError("");
    try {
      const result = await api.saveConfig(uuid, config, version, force);
      setConfig(result.config);
      setSaved(result.config);
      setVersion(result.configVersion);
      toast.success("Saved");
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === "CONFIG_CHANGED") {
        if (window.confirm("This configuration was changed elsewhere after it was opened. Overwrite those changes?")) {
          setIsSaving(false);
          await save(true);
          return;
        }
      }
      const message = e instanceof Error ? e.message : "Save failed";
      setError(message);
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  }, [api, config, onSaved, uuid, version]);

  const setAppConfig = setConfig as Dispatch<SetStateAction<AppConfig>>;

  if (!outer || !config) return null;

  const configValue = {
    ...outer,
    config,
    setConfig: setAppConfig,
    auth: { authenticated: true, userUUID: uuid, password: null, installUrl: null },
    setAuth: () => undefined,
  };

  const saveValue = {
    requestSave: () => { void save(); },
    isSaving,
    error,
    savedConfig: null,
    markConfigPersisted: () => undefined,
    isDirty,
    canSave: true,
    missingKeys: [],
    openInstall: () => undefined,
    installUrl: "",
  };

  const close = (open: boolean) => {
    if (open) return;
    if (isDirty && !window.confirm("Discard the unsaved changes?")) return;
    onClose();
  };

  return (
    <ConfigContext.Provider value={configValue}>
      <SaveContext.Provider value={saveValue}>
        <JellyfinDialog open onOpenChange={close} userUUID={uuid} addressId={alias ?? undefined} streamOptions={streamOptions} />
      </SaveContext.Provider>
    </ConfigContext.Provider>
  );
}
