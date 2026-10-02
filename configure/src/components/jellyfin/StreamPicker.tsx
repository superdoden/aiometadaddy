import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Jellyfin admin (fork): an entry of the dashboard's stream addon list. */
export interface StreamOption {
  name: string;
  url: string;
}

const CUSTOM = "__custom__";
const INHERIT = "__inherit__";

interface StreamPickerProps {
  value: string | undefined;
  options: StreamOption[];
  onChange: (url: string | undefined) => void;
  /** Shown as the empty choice, e.g. "Same as you"; without it the empty choice reads "None". */
  inheritLabel?: string;
  placeholder?: string;
}

/** A stream addon picked from the list by name, or any other address typed in. */
export function StreamPicker({ value, options, onChange, inheritLabel, placeholder }: StreamPickerProps) {
  const current = (value ?? "").trim();
  const listed = options.find((o) => o.url === current);
  const [custom, setCustom] = useState(Boolean(current) && !listed);
  useEffect(() => {
    if (listed) setCustom(false);
    else if (current) setCustom(true);
  }, [current, listed]);

  const selected = custom ? CUSTOM : listed ? listed.url : INHERIT;

  return (
    <div className="space-y-1.5">
      <Select
        value={selected}
        onValueChange={(v) => {
          if (v === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(v === INHERIT ? undefined : v);
        }}
      >
        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT}>{inheritLabel ?? "None (browse only)"}</SelectItem>
          {options.map((o) => <SelectItem key={o.url} value={o.url}>{o.name}</SelectItem>)}
          <SelectItem value={CUSTOM}>Other address…</SelectItem>
        </SelectContent>
      </Select>
      {custom ? (
        <Input
          className="h-8 font-mono text-xs"
          placeholder={placeholder ?? "https://your-aiostreams/stremio/<config>/manifest.json"}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value.trim() ? e.target.value : undefined)}
        />
      ) : null}
    </div>
  );
}
