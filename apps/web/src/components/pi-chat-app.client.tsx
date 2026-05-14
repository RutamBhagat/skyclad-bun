import "@tanstack/react-start/client-only";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, type Model, type TextContent } from "@earendil-works/pi-ai";
import { Button } from "@skyclad-bun/ui/components/button";
import { Input } from "@skyclad-bun/ui/components/input";
import { Check, History, Plus, Settings, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ApiKeyPromptDialog,
  AppStorage,
  ChatPanel,
  CustomProvidersStore,
  IndexedDBStorageBackend,
  ModelSelector,
  ProviderKeysStore,
  ProvidersModelsTab,
  ProxyTab,
  SessionListDialog,
  SessionsStore,
  SettingsDialog,
  SettingsStore,
  createJavaScriptReplTool,
  setAppStorage,
  type AgentState,
} from "@earendil-works/pi-web-ui";

const SYSTEM_PROMPT = `You are a helpful AI assistant with access to various tools.

Available tools:
- JavaScript REPL: Execute JavaScript code in a sandboxed browser environment (can do calculations, get time, process data, create visualizations, etc.)
- Artifacts: Create interactive HTML, SVG, Markdown, and text artifacts

Feel free to use these tools when needed to provide accurate and helpful responses.`;

const DEFAULT_MODEL_KEY = "chat.defaultModel";

type SessionRefs = {
  currentSessionId?: string;
  currentTitle: string;
  agent?: Agent;
};

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const configs = [
  settings.getConfig(),
  SessionsStore.getMetadataConfig(),
  providerKeys.getConfig(),
  customProviders.getConfig(),
  sessions.getConfig(),
];

const backend = new IndexedDBStorageBackend({
  dbName: "skyclad-pi-web",
  version: 1,
  stores: configs,
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

let customMessagesRegistered = false;

function registerPiMessages() {
  if (customMessagesRegistered) return;
  customMessagesRegistered = true;
}

function generateTitle(messages: AgentMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) return "";

  const content = firstUserMessage.content;
  const text =
    typeof content === "string"
      ? content
      : content
          .filter((item): item is TextContent => item.type === "text")
          .map((item) => item.text || "")
          .join(" ");

  const trimmed = text.trim();
  if (!trimmed) return "";

  const sentenceEnd = trimmed.search(/[.!?]/);
  if (sentenceEnd > 0 && sentenceEnd <= 50) {
    return trimmed.substring(0, sentenceEnd + 1);
  }

  return trimmed.length <= 50 ? trimmed : `${trimmed.substring(0, 47)}...`;
}

function shouldSaveSession(messages: AgentMessage[]) {
  const hasUserMessage = messages.some((message) => message.role === "user");
  const hasAssistantMessage = messages.some((message) => message.role === "assistant");

  return hasUserMessage && hasAssistantMessage;
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

async function createDefaultState(): Promise<Partial<AgentState>> {
  const savedModel = await storage.settings.get<Model<any>>(DEFAULT_MODEL_KEY);

  return {
    systemPrompt: SYSTEM_PROMPT,
    model: savedModel || getModel("anthropic", "claude-sonnet-4-5-20250929"),
    thinkingLevel: "off",
    messages: [],
    tools: [],
  };
}

export default function PiChatApp() {
  const panelHostRef = useRef<HTMLDivElement | null>(null);
  const chatPanelRef = useRef<ChatPanel | null>(null);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const sessionRef = useRef<SessionRefs>({ currentTitle: "" });

  const [currentTitle, setCurrentTitle] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const headerTitle = currentTitle || "Pi Chat";

  const saveSession = useCallback(async () => {
    const { agent, currentSessionId, currentTitle } = sessionRef.current;
    if (!agent || !currentSessionId || !currentTitle) return;

    const state = agent.state;
    if (!shouldSaveSession(state.messages)) return;

    const createdAt = new Date().toISOString();
    const sessionData = {
      id: currentSessionId,
      title: currentTitle,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      messages: state.messages,
      createdAt,
      lastModified: createdAt,
    };

    const metadata = {
      id: currentSessionId,
      title: currentTitle,
      createdAt,
      lastModified: createdAt,
      messageCount: state.messages.length,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      modelId: state.model.id || null,
      thinkingLevel: state.thinkingLevel,
      preview: generateTitle(state.messages),
    };

    try {
      await storage.sessions.save(sessionData, metadata);
    } catch (error) {
      console.error("Failed to save session:", error);
    }
  }, []);

  const createAgent = useCallback(
    async (initialState?: Partial<AgentState>) => {
      const chatPanel = chatPanelRef.current;
      if (!chatPanel) return;

      unsubscribeRef.current?.();

      const agent = new Agent({
        initialState: initialState || (await createDefaultState()),
      });

      sessionRef.current.agent = agent;
      unsubscribeRef.current = agent.subscribe((event) => {
        if (event.type === "message_end") {
          agent.state.messages = [...agent.state.messages];
        }

        if (event.type !== "message_end" && event.type !== "agent_end") return;

        const messages = agent.state.messages;
        if (!sessionRef.current.currentTitle && shouldSaveSession(messages)) {
          const nextTitle = generateTitle(messages);
          sessionRef.current.currentTitle = nextTitle;
          setCurrentTitle(nextTitle);
        }

        if (!sessionRef.current.currentSessionId && shouldSaveSession(messages)) {
          const sessionId = crypto.randomUUID();
          sessionRef.current.currentSessionId = sessionId;
          updateUrl(sessionId);
        }

        if (sessionRef.current.currentSessionId) {
          void saveSession();
        }

        if (event.type === "agent_end") {
          void agent.waitForIdle().then(() => {
            if (sessionRef.current.agent !== agent) return;
            chatPanel.agentInterface?.requestUpdate();
          });
        }
      });

      await chatPanel.setAgent(agent, {
        onApiKeyRequired: async (provider: string) => {
          return await ApiKeyPromptDialog.prompt(provider);
        },
        onModelSelect: () => {
          ModelSelector.open(agent.state.model, (model) => {
            agent.state.model = model;
            void storage.settings.set(DEFAULT_MODEL_KEY, model);
            void saveSession();
            chatPanel.agentInterface?.requestUpdate();
          });
        },
        toolsFactory: (_agent, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
          const replTool = createJavaScriptReplTool();
          replTool.runtimeProvidersFactory = runtimeProvidersFactory;
          return [replTool];
        },
      });
    },
    [saveSession],
  );

  const loadSession = useCallback(
    async (sessionId: string) => {
      const sessionData = await storage.sessions.get(sessionId);
      if (!sessionData) {
        console.error("Session not found:", sessionId);
        return false;
      }

      const metadata = await storage.sessions.getMetadata(sessionId);
      const title = metadata?.title || "";
      sessionRef.current.currentSessionId = sessionId;
      sessionRef.current.currentTitle = title;
      setCurrentTitle(title);

      await createAgent({
        model: sessionData.model,
        thinkingLevel: sessionData.thinkingLevel,
        messages: sessionData.messages,
        tools: [],
      });

      updateUrl(sessionId);
      return true;
    },
    [createAgent],
  );

  const startNewSession = useCallback(async () => {
    clearSessionUrl();
    sessionRef.current.currentSessionId = undefined;
    sessionRef.current.currentTitle = "";
    setCurrentTitle("");
    setDraftTitle("");
    setIsEditingTitle(false);
    await createAgent();
  }, [createAgent]);

  const commitTitle = useCallback(async () => {
    const nextTitle = draftTitle.trim();
    const sessionId = sessionRef.current.currentSessionId;
    if (nextTitle && sessionId && nextTitle !== sessionRef.current.currentTitle) {
      await storage.sessions.updateTitle(sessionId, nextTitle);
      sessionRef.current.currentTitle = nextTitle;
      setCurrentTitle(nextTitle);
    }
    setIsEditingTitle(false);
  }, [draftTitle]);

  const cancelTitleEdit = useCallback(() => {
    setDraftTitle(sessionRef.current.currentTitle);
    setIsEditingTitle(false);
  }, []);

  const openSessions = useCallback(() => {
    SessionListDialog.open(
      async (sessionId) => {
        await loadSession(sessionId);
      },
      (deletedSessionId) => {
        if (deletedSessionId === sessionRef.current.currentSessionId) {
          void startNewSession();
        }
      },
    );
  }, [loadSession, startNewSession]);

  const openSettings = useCallback(() => {
    SettingsDialog.open([new ProvidersModelsTab(), new ProxyTab()]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    registerPiMessages();

    const chatPanel = new ChatPanel();
    chatPanel.classList.add("min-h-0", "flex-1");
    chatPanelRef.current = chatPanel;
    panelHostRef.current?.append(chatPanel);

    const init = async () => {
      try {
        const sessionId = new URLSearchParams(window.location.search).get("session");
        if (sessionId) {
          const loaded = await loadSession(sessionId);
          if (!loaded) await startNewSession();
        } else {
          await createAgent();
        }
      } catch (error) {
        console.error("Failed to initialize Pi chat:", error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void init();

    return () => {
      cancelled = true;
      unsubscribeRef.current?.();
      unsubscribeRef.current = undefined;
      sessionRef.current.agent?.abort();
      chatPanel.remove();
      chatPanelRef.current = null;
    };
  }, [createAgent, loadSession, startNewSession]);

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
    <div className="truncate px-2 text-sm font-semibold">{headerTitle}</div>
  );

  return (
    <div className="flex h-svh w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border">
        <div className="flex min-w-0 items-center gap-1 px-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Sessions"
            onClick={openSessions}
          >
            <History />
          </Button>
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

        <div className="flex shrink-0 items-center gap-1 px-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Settings"
            onClick={openSettings}
          >
            <Settings />
          </Button>
        </div>
      </header>

      <main className="relative flex min-h-0 flex-1 flex-col">
        {isLoading ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background text-sm text-muted-foreground">
            Loading...
          </div>
        ) : null}
        <div ref={panelHostRef} className="flex min-h-0 flex-1 flex-col" />
      </main>
    </div>
  );
}
