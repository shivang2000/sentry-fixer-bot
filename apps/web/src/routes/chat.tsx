import { Button } from "@alertforge/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@alertforge/ui/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@alertforge/ui/components/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MessageSquareCode, Plus, Trash2, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { ChatTerminal, type ChatTerminalHandle } from "@/components/chat-terminal";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { OAuthCard } from "@/components/oauth-card";
import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/chat")({
  component: ChatPage,
});

function ChatPage() {
  const qc = useQueryClient();
  const sessions = useQuery(trpc.chat.list.queryOptions());
  const repos = useQuery(trpc.repos.list.queryOptions());

  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.chat.list.queryKey() });

  const create = useMutation(trpc.chat.create.mutationOptions({ onSuccess: invalidate }));
  const end = useMutation(trpc.chat.end.mutationOptions({ onSuccess: invalidate }));
  const del = useMutation(
    trpc.chat.delete.mutationOptions({
      onSuccess: () => {
        invalidate();
        toast.success("Session deleted");
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const termRef = useRef<ChatTerminalHandle>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [repoSelect, setRepoSelect] = useState<string>("__none__");
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const handleStart = async () => {
    try {
      const row = await create.mutateAsync({
        repo: repoSelect === "__none__" ? undefined : repoSelect,
      });
      setActiveId(row.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "create_failed";
      toast.error(msg);
    }
  };

  const handleEnd = async () => {
    if (!activeId) return;
    termRef.current?.endSession();
    await end.mutateAsync({ sessionId: activeId });
    setActiveId(null);
    setOauthUrl(null);
    toast.success("Session ended");
  };

  const handleOAuthPrompt = useCallback((url: string) => {
    setOauthUrl(url);
  }, []);

  const handleOAuthSubmit = (code: string) => {
    termRef.current?.sendOAuthCode(code);
    setOauthUrl(null);
  };

  const handleExit = useCallback((_code: number) => {
    setActiveId(null);
  }, []);

  return (
    <div className="flex h-[calc(100vh-3rem)] gap-4 p-6">
      <aside className="flex w-72 flex-shrink-0 flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquareCode className="h-4 w-4" />
              New session
            </CardTitle>
            <CardDescription>
              Spawns a Claude Code subprocess. One active session per user.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Select value={repoSelect} onValueChange={(v) => setRepoSelect(v ?? "__none__")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No repo (free chat)</SelectItem>
                {(repos.data ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.sentryProject}>
                    {r.sentryProject}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="w-full"
              disabled={create.isPending || activeId !== null}
              onClick={handleStart}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              {create.isPending ? "Starting…" : "Start session"}
            </Button>
            {activeId ? (
              <Button variant="destructive" className="w-full" onClick={() => setConfirmEnd(true)}>
                <X className="mr-1.5 h-4 w-4" />
                End session
              </Button>
            ) : null}
          </CardContent>
        </Card>

        <Card className="min-h-0 flex-1 overflow-auto">
          <CardHeader>
            <CardTitle className="text-base">Recent</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {sessions.isLoading ? (
              <p className="text-zinc-500">Loading…</p>
            ) : (sessions.data ?? []).length === 0 ? (
              <p className="text-zinc-500">No sessions yet.</p>
            ) : (
              (sessions.data ?? []).slice(0, 10).map((s) => (
                <div
                  key={s.id}
                  className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 ${
                    s.id === activeId ? "border-indigo-500 bg-indigo-500/10" : "border-zinc-800"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs">{s.id.slice(0, 8)}</div>
                    <div className="text-xs text-zinc-500">
                      {s.repo ?? "no repo"} • {s.status}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete session"
                    disabled={s.id === activeId || del.isPending}
                    title={
                      s.id === activeId
                        ? "End the active session before deleting"
                        : "Delete this session + its work dir"
                    }
                    onClick={() => del.mutate({ sessionId: s.id })}
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col gap-3">
        {oauthUrl ? (
          <OAuthCard
            url={oauthUrl}
            onSubmit={handleOAuthSubmit}
            onCancel={() => setOauthUrl(null)}
          />
        ) : null}
        {activeId ? (
          <ChatTerminal
            key={activeId}
            ref={termRef}
            sessionId={activeId}
            onOAuthPrompt={handleOAuthPrompt}
            onExit={handleExit}
          />
        ) : (
          <Card className="flex flex-1 items-center justify-center">
            <CardContent className="text-center text-sm text-zinc-500">
              <MessageSquareCode className="mx-auto mb-3 h-10 w-10 opacity-60" />
              Pick a repo (optional) and start a session.
            </CardContent>
          </Card>
        )}
      </main>

      <ConfirmDialog
        open={confirmEnd}
        onOpenChange={setConfirmEnd}
        title="End this chat session?"
        description="The Claude subprocess will be killed."
        confirmLabel="End session"
        variant="destructive"
        onConfirm={handleEnd}
      />
    </div>
  );
}
