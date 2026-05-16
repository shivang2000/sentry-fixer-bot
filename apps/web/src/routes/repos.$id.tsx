import { Button } from "@sentry-fixer-bot/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { RepoForm } from "@/components/repo-form";
import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/repos/$id")({
  component: EditRepoPage,
});

function EditRepoPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const q = useQuery(trpc.repos.byId.queryOptions({ id }));

  if (q.isLoading) return <div className="p-6">Loading…</div>;
  if (q.error) return <div className="p-6 text-red-600">{q.error.message}</div>;
  if (!q.data) {
    return (
      <div className="p-6">
        <p className="text-sm text-zinc-500">Repo not found.</p>
        <Link to="/repos">
          <Button variant="outline" className="mt-4">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Back to repos
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link to="/repos">
          <Button variant="ghost" size="icon" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="font-semibold text-2xl">Edit repo</h1>
          <p className="text-sm text-zinc-500">{q.data.sentryProject}</p>
        </div>
      </div>

      <RepoForm
        mode="edit"
        initial={{
          id: q.data.id,
          sentryProject: q.data.sentryProject,
          github: q.data.github,
          defaultBranch: q.data.defaultBranch,
          testCommand: q.data.testCommand,
          prReviewers: (q.data.prReviewers as string[]) ?? [],
          dailyTokenCap: q.data.dailyTokenCap,
          dailyCostCapCents: q.data.dailyCostCapCents,
          minSeverityToFix: q.data.minSeverityToFix as "low" | "medium" | "high" | "critical",
          enabled: q.data.enabled,
        }}
        onCancel={() => navigate({ to: "/repos" })}
        onSuccess={() => navigate({ to: "/repos" })}
      />
    </div>
  );
}
