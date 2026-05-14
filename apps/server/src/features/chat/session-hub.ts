import { join } from "node:path";

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type AgentSessionEvent,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { getModel, type Model } from "@earendil-works/pi-ai";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const SYSTEM_PROMPT = `You are a helpful AI assistant with access to various tools.

Available tools:
- JavaScript REPL: Execute JavaScript code in a sandboxed browser environment (can do calculations, get time, process data, create visualizations, etc.)
- Artifacts: Create interactive HTML, SVG, Markdown, and text artifacts

Feel free to use these tools when needed to provide accurate and helpful responses.`;

const DEFAULT_MODEL = getModel("anthropic", "claude-sonnet-4-5-20250929");

if (!DEFAULT_MODEL) {
  throw new Error("Default chat model not found.");
}

type CreateSessionOptions = {
  cwd?: string;
};

type SessionSnapshot = {
  sessionId: string;
  sessionFile?: string;
  title: string;
  model: Model<any> | undefined;
  thinkingLevel: ThinkingLevel;
  messages: unknown[];
  isStreaming: boolean;
};

type SessionRecord = {
  runtime: AgentSessionRuntime;
  sessionId: string;
  title: string;
  subscribers: Set<ReadableStreamDefaultController<Uint8Array>>;
  unsubscribe?: () => void;
};

function generateTitle(messages: Array<{ role?: string; content?: unknown }>) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) return "";

  const content = firstUserMessage.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((item): item is { type: "text"; text?: string } => item.type === "text")
            .map((item) => item.text || "")
            .join(" ")
        : "";

  const trimmed = text.trim();
  if (!trimmed) return "";

  const sentenceEnd = trimmed.search(/[.!?]/);
  if (sentenceEnd > 0 && sentenceEnd <= 50) {
    return trimmed.substring(0, sentenceEnd + 1);
  }

  return trimmed.length <= 50 ? trimmed : `${trimmed.substring(0, 47)}...`;
}

function shouldSaveSession(messages: Array<{ role?: string }>) {
  const hasUserMessage = messages.some((message) => message.role === "user");
  const hasAssistantMessage = messages.some((message) => message.role === "assistant");

  return hasUserMessage && hasAssistantMessage;
}

function encodeSse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export class ChatSessionHub {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly workspaceRoot = process.cwd();
  private readonly agentDir = join(this.workspaceRoot, ".pi");
  private readonly sessionDir = join(this.agentDir, "sessions");

  private createSessionManager(cwd: string) {
    return SessionManager.create(cwd, this.sessionDir);
  }

  private async createRuntime(cwd: string, sessionManager: SessionManager) {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: this.agentDir,
      resourceLoaderOptions: {
        systemPrompt: SYSTEM_PROMPT,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });

    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      model: DEFAULT_MODEL,
      thinkingLevel: "off" as ThinkingLevel,
      noTools: "all",
    });

    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  }

  private snapshot(record: SessionRecord): SessionSnapshot {
    const session = record.runtime.session;

    return {
      sessionId: record.sessionId,
      sessionFile: session.sessionFile,
      title: record.title,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      messages: session.messages,
      isStreaming: session.isStreaming,
    };
  }

  private broadcast(sessionId: string, event: string, data: unknown) {
    const record = this.sessions.get(sessionId);
    if (!record) return;

    const payload = encodeSse(event, data);
    for (const subscriber of record.subscribers) {
      try {
        subscriber.enqueue(payload);
      } catch {
        record.subscribers.delete(subscriber);
      }
    }
  }

  private attachRuntime(record: SessionRecord) {
    if (record.unsubscribe) {
      record.unsubscribe();
      record.unsubscribe = undefined;
    }

    record.runtime.setRebindSession(async (session) => {
      const previousSessionId = record.sessionId;
      record.sessionId = session.sessionId;

      if (previousSessionId !== record.sessionId) {
        this.sessions.delete(previousSessionId);
        this.sessions.set(record.sessionId, record);
      }

      if (record.unsubscribe) {
        record.unsubscribe();
      }

      record.unsubscribe = session.subscribe((event) => {
        void this.handleEvent(record, event);
      });
    });

    record.unsubscribe = record.runtime.session.subscribe((event) => {
      void this.handleEvent(record, event);
    });
  }

  private async handleEvent(record: SessionRecord, event: AgentSessionEvent) {
    if (event.type === "message_end" || event.type === "agent_end") {
      const messages = record.runtime.session.messages as Array<{ role?: string; content?: unknown }>;
      if (!record.title && shouldSaveSession(messages)) {
        const nextTitle = generateTitle(messages);
        if (nextTitle) {
          record.title = nextTitle;
          record.runtime.session.setSessionName(nextTitle);
        }
      }
    }

    if (event.type === "session_info_changed") {
      record.title = record.runtime.session.sessionManager.getSessionName() || "";
    }

    this.broadcast(record.sessionId, "event", event);

    if (
      event.type === "message_end" ||
      event.type === "agent_end" ||
      event.type === "thinking_level_changed" ||
      event.type === "session_info_changed"
    ) {
      this.broadcast(record.sessionId, "snapshot", this.snapshot(record));
    }
  }

  async createSession(options: CreateSessionOptions = {}): Promise<SessionSnapshot> {
    const cwd = options.cwd ?? this.workspaceRoot;
    const sessionManager = this.createSessionManager(cwd);
    const runtime = await createAgentSessionRuntime(async () => this.createRuntime(cwd, sessionManager), {
      cwd,
      agentDir: this.agentDir,
      sessionManager,
    });

    const record: SessionRecord = {
      runtime,
      sessionId: runtime.session.sessionId,
      title: runtime.session.sessionManager.getSessionName() || "",
      subscribers: new Set(),
    };

    this.sessions.set(record.sessionId, record);
    this.attachRuntime(record);
    this.broadcast(record.sessionId, "snapshot", this.snapshot(record));
    return this.snapshot(record);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return record;
  }

  snapshotSession(sessionId: string): SessionSnapshot {
    return this.snapshot(this.requireSession(sessionId));
  }

  async prompt(sessionId: string, text: string): Promise<SessionSnapshot> {
    const record = this.requireSession(sessionId);
    await record.runtime.session.prompt(text);
    return this.snapshot(record);
  }

  async abort(sessionId: string): Promise<SessionSnapshot> {
    const record = this.requireSession(sessionId);
    await record.runtime.session.abort();
    return this.snapshot(record);
  }

  async waitForIdle(sessionId: string): Promise<SessionSnapshot> {
    const record = this.requireSession(sessionId);
    await record.runtime.session.agent.waitForIdle();
    return this.snapshot(record);
  }

  async setTitle(sessionId: string, title: string): Promise<SessionSnapshot> {
    const record = this.requireSession(sessionId);
    record.title = title.trim();
    record.runtime.session.setSessionName(record.title);
    return this.snapshot(record);
  }

  createEventStream(sessionId: string): Response {
    const record = this.requireSession(sessionId);

    let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = controller;
        record.subscribers.add(controller);
        controller.enqueue(encodeSse("snapshot", this.snapshot(record)));
      },
      cancel: (reason) => {
        void reason;
        if (subscriber) {
          record.subscribers.delete(subscriber);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }
}

export const chatSessionHub = new ChatSessionHub();
export type { SessionSnapshot };
