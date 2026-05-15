import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/repos")({
  component: ReposPage,
});

function ReposPage() {
  const list = useQuery(trpc.repos.list.queryOptions());

  if (list.isLoading) return <div className="p-6">Loading…</div>;
  if (list.error) return <div className="p-6 text-red-600">{list.error.message}</div>;
  const rows = list.data ?? [];

  return (
    <div className="p-6">
      <h1 className="mb-4 font-semibold text-2xl">Repos</h1>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No repos configured yet. Use the API to add one.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th className="py-2">Sentry project</th>
              <th>GitHub</th>
              <th>Branch</th>
              <th>Daily cost cap</th>
              <th>Min severity</th>
              <th>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="py-2">{r.sentryProject}</td>
                <td>{r.github}</td>
                <td>{r.defaultBranch}</td>
                <td>${(r.dailyCostCapCents / 100).toFixed(2)}</td>
                <td>{r.minSeverityToFix}</td>
                <td>{r.enabled ? "✓" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
