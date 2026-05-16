import { Button } from "@sentry-fixer-bot/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sentry-fixer-bot/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";
import { useEffect } from "react";
import { z } from "zod";

import { Stepper } from "@/components/stepper";
import { trpc } from "@/utils/trpc";

const searchSchema = z.object({
  // Accept any truthy value (?force=1 or ?force=true). Coerce to boolean.
  force: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  component: HomeWizard,
});

function HomeWizard() {
  const { force } = useSearch({ from: "/" });
  const forced = force !== undefined && force !== false && force !== "" && force !== "0";
  const navigate = useNavigate();
  const status = useQuery(trpc.setup.status.queryOptions());

  const steps = status.data?.steps ?? [];
  const ready = status.data?.ready ?? false;
  const current = steps.find((s) => !s.done);

  useEffect(() => {
    if (ready && !forced) {
      navigate({ to: "/chat" });
    }
  }, [ready, forced, navigate]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header>
        <h1 className="font-semibold text-xl">Welcome to sentry-fixer-bot</h1>
        <p className="text-sm text-zinc-500">
          Four-step setup. Each step persists on the state volume so a container restart won't lose
          anything.
        </p>
      </header>

      {status.isLoading ? (
        <p className="text-sm text-zinc-500">Checking setup…</p>
      ) : steps.length === 0 ? (
        <p className="text-red-300 text-sm">Couldn't run setup probes. Check server logs.</p>
      ) : (
        <>
          <Card>
            <CardContent className="pt-6">
              <Stepper
                steps={steps.map((s) => ({ id: s.id, label: s.label, done: s.done }))}
                currentId={current?.id}
              />
            </CardContent>
          </Card>

          {current ? (
            <Card className="border-indigo-500/30 bg-indigo-500/5">
              <CardHeader>
                <CardTitle className="text-base text-indigo-200">
                  Step {steps.findIndex((s) => s.id === current.id) + 1} of {steps.length}:{" "}
                  {current.label}
                </CardTitle>
                <CardDescription className="text-indigo-200/70">{current.detail}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {current.actionHref ? (
                  <Link to={current.actionHref}>
                    <Button>
                      Take me there
                      <ArrowRight className="ml-1.5 h-4 w-4" />
                    </Button>
                  </Link>
                ) : null}
              </CardContent>
            </Card>
          ) : (
            <Card className="border-emerald-500/30 bg-emerald-500/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-emerald-200">
                  <Check className="h-4 w-4" /> Setup complete
                </CardTitle>
                <CardDescription className="text-emerald-200/70">
                  All four checks are green. Redirecting to /chat…
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Link to="/chat">
                  <Button>
                    Open chat
                    <ArrowRight className="ml-1.5 h-4 w-4" />
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">All steps</CardTitle>
              <CardDescription>Click any step to jump to where it's configured.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {steps.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    {s.done ? (
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                        <Check className="h-3 w-3" />
                      </span>
                    ) : (
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 text-[10px] text-zinc-500">
                        {steps.findIndex((x) => x.id === s.id) + 1}
                      </span>
                    )}
                    <div>
                      <div className="font-medium">{s.label}</div>
                      <div className="text-xs text-zinc-500">{s.detail}</div>
                    </div>
                  </div>
                  {s.actionHref ? (
                    <Link to={s.actionHref}>
                      <Button variant="ghost" size="sm">
                        {s.done ? "Manage" : "Set up"}
                      </Button>
                    </Link>
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
