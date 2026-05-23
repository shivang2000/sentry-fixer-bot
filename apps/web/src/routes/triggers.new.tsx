import { Button } from "@alertforge/ui/components/button";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";

import { TriggerForm } from "@/components/triggers/trigger-form";

const SearchSchema = z.object({
  // Optional pre-pick from /sources or the manual-URL "no trigger" link.
  source: z.string().optional(),
});

export const Route = createFileRoute("/triggers/new")({
  validateSearch: (s) => SearchSchema.parse(s),
  component: NewTriggerPage,
});

function NewTriggerPage() {
  const navigate = useNavigate();
  const { source } = Route.useSearch();

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link to="/triggers">
          <Button variant="ghost" size="icon" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="font-semibold text-2xl">New trigger</h1>
          <p className="text-sm text-zinc-500">
            Connect an alert source to a repo. Pick a preset (or fall through to Custom) and tune
            models / budget.
          </p>
        </div>
      </div>

      <TriggerForm
        mode="create"
        initialSource={source}
        onCancel={() => navigate({ to: "/triggers" })}
        onSuccess={(id) => {
          if (id) navigate({ to: "/triggers/$id", params: { id } });
          else navigate({ to: "/triggers" });
        }}
      />
    </div>
  );
}
