import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/runs")({
  component: RunsPage,
});

function RunsPage() {
  const list = useQuery(trpc.runs.list.queryOptions({ limit: 50 }));

  if (list.isLoading) return <div className="p-6">Loading…</div>;
  if (list.error) return <div className="p-6 text-red-600">{list.error.message}</div>;
  const rows = list.data ?? [];

  return (
    <div className="p-6">
      <h1 className="mb-4 font-semibold text-2xl">Runs</h1>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No runs yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th className="py-2">Started</th>
              <th>Status</th>
              <th>Severity</th>
              <th>Alert</th>
              <th>PR</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ run, alert, pr }) => (
              <tr key={run.id} className="border-t align-top">
                <td className="whitespace-nowrap py-2">
                  {new Date(run.startedAt).toLocaleString()}
                </td>
                <td className="font-mono">{run.status}</td>
                <td>{run.severity ?? "—"}</td>
                <td className="max-w-md truncate">{alert.title}</td>
                <td>
                  {pr ? (
                    <a
                      className="text-blue-600 underline"
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      #{pr.number} {pr.isDraft ? "(draft)" : ""}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
