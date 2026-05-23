import { Button } from "@alertforge/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@alertforge/ui/components/card";
import { Power, Trash2 } from "lucide-react";

type ChannelRow = {
  id: string;
  channelType: string;
  enabled: boolean;
  notifyOn: string[];
  config: Record<string, unknown>;
  lastSendAt: string | Date | null;
  lastSendOk: boolean | null;
  lastSendErr: string | null;
};

type Props = {
  row: ChannelRow;
  onToggleEnabled?: (id: string, next: boolean) => void;
  onDelete?: (id: string, type: string) => void;
};

export function ChannelCard({ row, onToggleEnabled, onDelete }: Props) {
  // Render the channel config inline as key:value pairs, redacting any
  // field that looks secret. We don't have an explicit per-field secret
  // marker from configSchema yet, so heuristic on the key name.
  const entries = Object.entries(row.config ?? {});

  return (
    <Card className={row.enabled ? undefined : "opacity-60"}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="capitalize">{row.channelType}</span>
          <span className="text-[11px] text-zinc-500">
            {row.lastSendAt ? (
              <>
                Last send: {new Date(row.lastSendAt).toLocaleString()}{" "}
                {row.lastSendOk === true ? (
                  <span className="text-emerald-300">✓</span>
                ) : row.lastSendOk === false ? (
                  <span className="text-red-300">✗</span>
                ) : null}
              </>
            ) : (
              "Never sent"
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          {entries.map(([k, v]) => (
            <RowKv key={k} k={k} v={v} />
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-zinc-500">Notify on:</span>
          {row.notifyOn.length === 0 ? (
            <span className="text-zinc-500">(none)</span>
          ) : (
            row.notifyOn.map((n) => (
              <span
                key={n}
                className="rounded-full bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px]"
              >
                {n}
              </span>
            ))
          )}
        </div>
        {row.lastSendErr ? (
          <p className="rounded-md bg-red-500/10 p-2 text-[11px] text-red-200">{row.lastSendErr}</p>
        ) : null}
        <div className="flex gap-1 pt-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onToggleEnabled?.(row.id, !row.enabled)}
            aria-label={row.enabled ? "Disable channel" : "Enable channel"}
          >
            <Power className="mr-1 h-3 w-3" />
            {row.enabled ? "Disable" : "Enable"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onDelete?.(row.id, row.channelType)}
            className="ml-auto text-red-300 hover:text-red-200"
            aria-label="Delete channel"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RowKv({ k, v }: { k: string; v: unknown }) {
  const isSecret = /webhook|secret|key|token|password/i.test(k);
  let rendered: string;
  if (Array.isArray(v)) rendered = v.join(", ");
  else if (typeof v === "object" && v !== null) rendered = JSON.stringify(v);
  else rendered = String(v ?? "");
  return (
    <>
      <dt className="font-mono text-zinc-500">{k}:</dt>
      <dd className="break-all">
        {isSecret && rendered.length > 0 ? (
          <span title={rendered} className="font-mono text-zinc-400">
            {rendered.slice(0, 18)}…
          </span>
        ) : (
          <span className="font-mono text-zinc-200">{rendered}</span>
        )}
      </dd>
    </>
  );
}
