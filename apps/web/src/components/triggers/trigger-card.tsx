import { Button } from "@sentry-fixer-bot/ui/components/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@sentry-fixer-bot/ui/components/card";
import { Link } from "@tanstack/react-router";
import { Pencil, Power, Trash2 } from "lucide-react";

import { OutcomeChart } from "./outcome-chart";

type TriggerListRow = {
  trigger: {
    id: string;
    sourceType: string;
    sourceProject: string;
    name: string;
    preset: string;
    enabled: boolean;
    createdAt: string | Date;
    updatedAt: string | Date;
  };
  repo: {
    id: string;
    github: string;
  };
};

type Props = {
  row: TriggerListRow;
  onToggleEnabled?: (id: string, next: boolean) => void;
  onDelete?: (id: string, name: string) => void;
};

const PRESET_LABEL: Record<string, string> = {
  triage_only: "Triage-only",
  auto_fix: "Auto-fix",
  auto_fix_review: "Auto-fix + review",
  custom: "Custom",
};

const PRESET_DOT: Record<string, string> = {
  triage_only: "bg-zinc-400",
  auto_fix: "bg-emerald-400",
  auto_fix_review: "bg-indigo-400",
  custom: "bg-amber-400",
};

export function TriggerCard({ row, onToggleEnabled, onDelete }: Props) {
  const { trigger, repo } = row;
  return (
    <Card className={trigger.enabled ? undefined : "opacity-60"}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="truncate">
            <span className="font-mono text-xs text-zinc-500 uppercase">{trigger.sourceType}</span>
            <span className="mx-1.5 text-zinc-600">→</span>
            <span className="font-medium">{trigger.name}</span>
          </span>
          <span
            className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-zinc-400"
            title={`preset: ${PRESET_LABEL[trigger.preset] ?? trigger.preset}`}
          >
            <span
              className={`h-2 w-2 rounded-full ${PRESET_DOT[trigger.preset] ?? "bg-zinc-400"}`}
              aria-hidden="true"
            />
            {PRESET_LABEL[trigger.preset] ?? trigger.preset}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-zinc-400">
          Repo: <span className="font-mono text-zinc-200">{repo.github}</span>
        </p>
        <p className="text-zinc-400">
          Source project: <span className="font-mono text-zinc-200">{trigger.sourceProject}</span>
        </p>
        <OutcomeChart triggerId={trigger.id} className="pt-2" />
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-1 border-zinc-900 border-t pt-3">
        <Link to="/triggers/$id" params={{ id: trigger.id }}>
          <Button size="sm" variant="outline">
            <Pencil className="mr-1 h-3 w-3" /> Edit
          </Button>
        </Link>
        <Button
          size="sm"
          variant="ghost"
          aria-label={trigger.enabled ? "Disable trigger" : "Enable trigger"}
          onClick={() => onToggleEnabled?.(trigger.id, !trigger.enabled)}
        >
          <Power className="mr-1 h-3 w-3" />
          {trigger.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Delete ${trigger.name}`}
          onClick={() => onDelete?.(trigger.id, trigger.name)}
          className="ml-auto text-red-300 hover:text-red-200"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </CardFooter>
    </Card>
  );
}
