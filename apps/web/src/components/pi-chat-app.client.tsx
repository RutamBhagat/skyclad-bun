import "@tanstack/react-start/client-only";

import { getModels } from "@earendil-works/pi-ai";
import { Button } from "@skyclad-bun/ui/components/button";
import { Input } from "@skyclad-bun/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@skyclad-bun/ui/components/select";
import { Textarea } from "@skyclad-bun/ui/components/textarea";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Check, MessageSquare, Plus, Send, Square, Trash2, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createSession,
  deleteSession,
  listSessions,
  loadSessionSnapshot,
  RemoteChatSession,
  type ServerSessionListItem,
  type ServerSessionSnapshot,
} from "./remote-chat-session";

const selectableModels = [
  ...getModels("openai-codex"),
  ...getModels("google"),
];

function messageText(message: AgentMessage) {
  const content = (message as { content?: unknown }).content;

  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .filter((item): item is { type: string; text?: string } => {
        return typeof item === "object" && item !== null && "type" in item;
      })
      .filter((item) => item.type === "text")
      .map((item) => item.text || "")
      .join("\n");
  }

  return "";
}

type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name?: string;
  arguments?: unknown;
};

type TextBlock = {
  type: "text";
  text?: string;
};

type ThinkingBlock = {
  type: "thinking";
  thinking?: string;
};

type AssistantContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

type ToolResultMessage = AgentMessage & {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content?: unknown;
  isError?: boolean;
};

function messageContentBlocks(message: AgentMessage) {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];

  return content.filter((item): item is AssistantContentBlock => {
    if (typeof item !== "object" || item === null || !("type" in item)) {
      return false;
    }

    const type = (item as { type?: unknown }).type;
    return type === "text" || type === "thinking" || type === "toolCall";
  });
}

function toolResultText(result?: ToolResultMessage) {
  if (!result) return "";
  return messageText(result);
}

function formatJson(value: unknown) {
  if (value === undefined) return "";

  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildToolResultsById(messages: AgentMessage[]) {
  const results = new Map<string, ToolResultMessage>();

  for (const message of messages) {
    if ((message as { role?: string }).role === "toolResult") {
      const result = message as ToolResultMessage;
      results.set(result.toolCallId, result);
    }
  }

  return results;
}

function ToolCallPanel({
  toolCall,
  result,
  pending,
}: {
  toolCall: ToolCallBlock;
  result?: ToolResultMessage;
  pending: boolean;
}) {
  const toolName = toolCall.name || result?.toolName || "tool";
  const output = toolResultText(result);
  const args = formatJson(toolCall.arguments);

  return (
    <div className="max-w-[80%] rounded-md border border-border bg-card p-3 text-card-foreground shadow-sm">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Wrench className="size-4 text-muted-foreground" />
        <span>{toolName}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {pending ? "Running" : result?.isError ? "Failed" : result ? "Done" : "Queued"}
        </span>
      </div>
      {args ? (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">Input</div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
            {args}
          </pre>
        </div>
      ) : null}
      {result ? (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">Result</div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
            {output || "(no output)"}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function AssistantMessageView({
  message,
  toolResultsById,
  pendingToolCalls,
}: {
  message: AgentMessage;
  toolResultsById: Map<string, ToolResultMessage>;
  pendingToolCalls: ReadonlySet<string>;
}) {
  const blocks = messageContentBlocks(message);
  if (!blocks.length) {
    const text = messageText(message);
    if (!text.trim()) return null;

    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-muted px-4 py-2">
          {text}
        </div>
      </div>
    );
  }

  return (
    <>
      {blocks.map((block, blockIndex) => {
        if (block.type === "text" || block.type === "thinking") {
          const text = block.type === "text" ? block.text : block.thinking;
          if (!text?.trim()) return null;

          return (
            <div key={`text-${blockIndex}`} className="flex justify-start">
              <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-muted px-4 py-2">
                {text}
              </div>
            </div>
          );
        }

        return (
          <div key={block.id || `tool-${blockIndex}`} className="flex justify-start">
            <ToolCallPanel
              toolCall={block}
              result={toolResultsById.get(block.id)}
              pending={pendingToolCalls.has(block.id)}
            />
          </div>
        );
      })}
    </>
  );
}

function updateUrl(sessionId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionId);
  window.history.replaceState({}, "", url);
}

function clearSessionUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("session");
  window.history.replaceState({}, "", url);
}

export default function PiChatApp() {
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<{
    session?: RemoteChatSession;
    currentTitle: string;
  }>({ currentTitle: "" });

  const [currentTitle, setCurrentTitle] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftMessage, setDraftMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [renderTick, setRenderTick] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [sessions, setSessions] = useState<ServerSessionListItem[]>([]);

  const refreshSessions = useCallback(async () => {
    setSessions(await listSessions());
  }, []);

  const bindSession = useCallback(async (snapshot: ServerSessionSnapshot) => {
    sessionRef.current.session?.dispose();
    sessionRef.current.session = new RemoteChatSession(
      snapshot.sessionId,
      snapshot,
    );
    sessionRef.current.currentTitle = snapshot.title || "";
    setCurrentTitle(snapshot.title || "");
    setErrorMessage("");
    setRenderTick((tick) => tick + 1);

    sessionRef.current.session.subscribe((event) => {
      if (event.type === "snapshot") {
        const nextSnapshot = event.snapshot as ServerSessionSnapshot;
        sessionRef.current.currentTitle = nextSnapshot.title || "";
        setCurrentTitle(nextSnapshot.title || "");
        if (nextSnapshot.sessionId) {
          updateUrl(nextSnapshot.sessionId);
        }
        void refreshSessions();
      }
      setRenderTick((tick) => tick + 1);
    });
  }, [refreshSessions]);

  const startNewSession = useCallback(async () => {
    clearSessionUrl();
    sessionRef.current.currentTitle = "";
    sessionRef.current.session?.dispose();
    sessionRef.current.session = undefined;
    setCurrentTitle("");
    setDraftTitle("");
    setIsEditingTitle(false);

    const snapshot = await createSession();
    updateUrl(snapshot.sessionId);
    await bindSession(snapshot);
    await refreshSessions();
  }, [bindSession, refreshSessions]);

  const loadSession = useCallback(async (sessionId: string) => {
    setIsLoading(true);
    try {
      const snapshot = await loadSessionSnapshot(sessionId);
      updateUrl(snapshot.sessionId);
      await bindSession(snapshot);
    } finally {
      setIsLoading(false);
    }
  }, [bindSession]);

  const removeSession = useCallback(async (sessionId: string) => {
    await deleteSession(sessionId);

    if (sessionRef.current.session?.sessionId !== sessionId) {
      await refreshSessions();
      return;
    }

    const remainingSessions = await listSessions();
    setSessions(remainingSessions);

    if (remainingSessions[0]) {
      await loadSession(remainingSessions[0].sessionId);
      return;
    }

    await startNewSession();
  }, [loadSession, refreshSessions, startNewSession]);

  const commitTitle = useCallback(async () => {
    const nextTitle = draftTitle.trim();
    const session = sessionRef.current.session;
    if (nextTitle && session && nextTitle !== sessionRef.current.currentTitle) {
      await session.setSessionName(nextTitle);
      sessionRef.current.currentTitle = nextTitle;
      setCurrentTitle(nextTitle);
      await refreshSessions();
    }
    setIsEditingTitle(false);
  }, [draftTitle, refreshSessions]);

  const cancelTitleEdit = useCallback(() => {
    setDraftTitle(sessionRef.current.currentTitle);
    setIsEditingTitle(false);
  }, []);

  const selectModel = useCallback((modelKey: string) => {
    const session = sessionRef.current.session;
    if (!session) return;

    const model = selectableModels.find((item) => {
      return `${item.provider}/${item.id}` === modelKey;
    });

    if (!model) return;

    session.state.model = model;
    setRenderTick((tick) => tick + 1);
  }, []);

  const sendMessage = useCallback(async () => {
    const input = draftMessage.trim();
    const session = sessionRef.current.session;

    if (!input || !session || session.state.isStreaming) return;

    setDraftMessage("");
    setErrorMessage("");
    setRenderTick((tick) => tick + 1);

    try {
      await session.prompt(input);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setRenderTick((tick) => tick + 1);
    }
  }, [draftMessage]);

  const abortMessage = useCallback(() => {
    sessionRef.current.session?.abort();
    setRenderTick((tick) => tick + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const sessionId = new URLSearchParams(window.location.search).get(
          "session",
        );
        const snapshot = await createSession(sessionId || undefined);
        if (snapshot.sessionId !== sessionId) {
          updateUrl(snapshot.sessionId);
        }
        await bindSession(snapshot);
        await refreshSessions();
      } catch (error) {
        console.error("Failed to initialize Pi chat:", error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void init();

    return () => {
      cancelled = true;
      sessionRef.current.session?.abort();
      sessionRef.current.session?.dispose();
    };
  }, [bindSession, refreshSessions]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [renderTick]);

  const sessionList = sessions.length ? (
    sessions.map((session) => {
      const isCurrent = session.sessionId === sessionRef.current.session?.sessionId;
      const title = session.title || "Untitled session";

      return (
        <div
          key={session.sessionId}
          className={
            isCurrent
              ? "flex items-center gap-1 bg-muted"
              : "flex items-center gap-1"
          }
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-w-0 flex-1 justify-start"
            title={title}
            onClick={() => void loadSession(session.sessionId)}
          >
            <MessageSquare />
            <span className="truncate">{title}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Delete session"
            onClick={() => void removeSession(session.sessionId)}
          >
            <Trash2 />
          </Button>
        </div>
      );
    })
  ) : (
    <div className="px-3 py-2 text-xs text-muted-foreground">No saved sessions</div>
  );

  const titleEditor = isEditingTitle ? (
    <div className="flex min-w-0 items-center gap-1">
      <Input
        value={draftTitle}
        className="h-7 w-56"
        autoFocus
        onChange={(event) => setDraftTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commitTitle();
          if (event.key === "Escape") cancelTitleEdit();
        }}
      />
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        title="Save title"
        onClick={() => void commitTitle()}
      >
        <Check />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        title="Cancel title edit"
        onClick={cancelTitleEdit}
      >
        <X />
      </Button>
    </div>
  ) : currentTitle ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="max-w-[min(32rem,45vw)] truncate text-sm font-medium"
      title="Edit title"
      onClick={() => {
        setDraftTitle(currentTitle);
        setIsEditingTitle(true);
      }}
    >
      {currentTitle}
    </Button>
  ) : (
    <div className="truncate px-2 text-sm font-semibold">Pi Chat</div>
  );

  const session = sessionRef.current.session;
  const messages = session?.state.messages ?? [];
  const toolResultsById = buildToolResultsById(messages);
  const pendingToolCalls = session?.state.pendingToolCalls ?? new Set<string>();
  const isStreaming = Boolean(session?.state.isStreaming);

  return (
    <div className="flex h-svh w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border">
        <div className="flex min-w-0 items-center gap-1 px-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="New session"
            onClick={() => void startNewSession()}
          >
            <Plus />
          </Button>
          {titleEditor}
        </div>
      </header>

      <main className="relative flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
            Sessions
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">{sessionList}</div>
        </aside>
        <div className="relative flex min-w-0 flex-1 flex-col">
          {isLoading ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background text-sm text-muted-foreground">
              Loading...
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
                {messages.length ? (
                  messages.map((message, index) => {
                    const role = (message as { role?: string }).role || "message";

                    if (role === "toolResult") return null;

                    if (role === "assistant") {
                      return (
                        <AssistantMessageView
                          key={`${role}-${index}`}
                          message={message}
                          toolResultsById={toolResultsById}
                          pendingToolCalls={pendingToolCalls}
                        />
                      );
                    }

                    const text = messageText(message);

                    return (
                      <div
                        key={`${role}-${index}`}
                        className={
                          role === "user"
                            ? "flex justify-end"
                            : "flex justify-start"
                        }
                      >
                        <div
                          className={
                            role === "user"
                              ? "max-w-[80%] whitespace-pre-wrap rounded-lg bg-primary px-4 py-2 text-primary-foreground"
                              : "max-w-[80%] whitespace-pre-wrap rounded-lg bg-muted px-4 py-2"
                          }
                        >
                          {text || `[${role}]`}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    Start a new research chat.
                  </div>
                )}
                {session?.state.streamingMessage ? (
                  <AssistantMessageView
                    message={session.state.streamingMessage}
                    toolResultsById={toolResultsById}
                    pendingToolCalls={pendingToolCalls}
                  />
                ) : null}
                {errorMessage || session?.state.errorMessage ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {errorMessage || session?.state.errorMessage}
                  </div>
                ) : null}
                <div ref={messagesEndRef} />
              </div>
            </div>
            <div className="shrink-0 border-t border-border bg-background/95">
              <div className="mx-auto max-w-3xl p-3">
                <div className="flex flex-col gap-2 border border-input bg-background p-2 shadow-sm">
                  <Textarea
                    value={draftMessage}
                    rows={1}
                    className="max-h-40 min-h-11 resize-none border-transparent bg-transparent px-1 py-1.5 text-sm focus-visible:border-transparent focus-visible:ring-0 md:text-sm"
                    placeholder="Ask about papers, methods, or related work"
                    disabled={!session}
                    onChange={(event) => setDraftMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="ml-auto flex items-center gap-2">
                      <Select
                        value={session?.state.model ? `${session.state.model.provider}/${session.state.model.id}` : null}
                        disabled={!session || isStreaming}
                        onValueChange={(value) => {
                          if (typeof value === "string") selectModel(value);
                        }}
                      >
                        <SelectTrigger className="h-9 w-64 border-transparent bg-muted/60 px-2.5 text-muted-foreground hover:bg-muted">
                          <SelectValue placeholder="Select model" />
                        </SelectTrigger>
                        <SelectContent
                          align="end"
                          side="top"
                          sideOffset={6}
                          alignItemWithTrigger={false}
                          className="max-h-72 w-64"
                        >
                          {selectableModels.map((model) => (
                            <SelectItem
                              key={`${model.provider}/${model.id}`}
                              value={`${model.provider}/${model.id}`}
                            >
                              <span className="truncate">{model.id}</span>
                              <span className="ml-auto text-muted-foreground">{model.provider}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {isStreaming ? (
                        <Button
                          type="button"
                          size="icon-lg"
                          variant="outline"
                          className="size-9"
                          title="Stop response"
                          onClick={abortMessage}
                        >
                          <Square />
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="icon-lg"
                          className="size-9"
                          title="Send message"
                          disabled={!draftMessage.trim() || !session}
                          onClick={() => void sendMessage()}
                        >
                          <Send />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
