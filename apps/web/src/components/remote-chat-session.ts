import { env } from "@skyclad-bun/env/web";
import type { Agent } from "@earendil-works/pi-agent-core";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ServerModel = {
  provider: string;
  id: string;
  name?: string;
};

export type ServerSessionSnapshot = {
  sessionId: string;
  sessionFile?: string;
  title: string;
  model: ServerModel | undefined;
  thinkingLevel: ThinkingLevel;
  messages: Array<{ role?: string; content?: unknown }>;
  isStreaming: boolean;
};

type RemoteSessionState = {
  systemPrompt: string;
  model: ServerModel | undefined;
  thinkingLevel: ThinkingLevel;
  messages: Array<{ role?: string; content?: unknown }>;
  tools: unknown[];
  isStreaming: boolean;
  streamingMessage?: unknown;
  pendingToolCalls: ReadonlySet<string>;
};

type RemoteSessionEvent = {
  type: string;
  [key: string]: unknown;
};

export class RemoteChatSession {
  public state: RemoteSessionState;
  public streamFn?: unknown;
  public getApiKey?: unknown;

  private listeners = new Set<
    (event: RemoteSessionEvent) => void | Promise<void>
  >();
  private eventSource?: EventSource;
  private title: string;
  private stateModel: ServerModel | undefined;
  private stateThinkingLevel: ThinkingLevel;
  private suppressStateSync = false;

  constructor(
    public sessionId: string,
    snapshot: ServerSessionSnapshot,
  ) {
    this.title = snapshot.title;
    this.stateModel = snapshot.model;
    this.stateThinkingLevel = snapshot.thinkingLevel;

    this.state = {
      systemPrompt: "",
      model: snapshot.model,
      thinkingLevel: snapshot.thinkingLevel,
      messages: [...snapshot.messages],
      tools: [],
      isStreaming: snapshot.isStreaming,
      streamingMessage: undefined,
      pendingToolCalls: new Set(),
    };

    Object.defineProperties(this.state, {
      model: {
        enumerable: true,
        configurable: true,
        get: () => this.stateModel,
        set: (model: ServerModel | undefined) => {
          void this.syncModel(model);
        },
      },
      thinkingLevel: {
        enumerable: true,
        configurable: true,
        get: () => this.stateThinkingLevel,
        set: (thinkingLevel: ThinkingLevel) => {
          void this.syncThinkingLevel(thinkingLevel);
        },
      },
    });

    this.connect();
  }

  subscribe(listener: (event: RemoteSessionEvent) => void | Promise<void>) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(text: string) {
    this.state.isStreaming = true;
    try {
      return await this.request<ServerSessionSnapshot>(
        `/api/chat/sessions/${encodeURIComponent(this.sessionId)}/prompt`,
        {
          method: "POST",
          body: JSON.stringify({ text }),
        },
      );
    } catch (error) {
      this.state.isStreaming = false;
      this.state.streamingMessage = undefined;
      throw error;
    }
  }

  async abort() {
    try {
      return await this.request<ServerSessionSnapshot>(
        `/api/chat/sessions/${encodeURIComponent(this.sessionId)}/abort`,
        {
          method: "POST",
        },
      );
    } finally {
      this.state.isStreaming = false;
      this.state.streamingMessage = undefined;
    }
  }

  async waitForIdle() {
    return await this.request<ServerSessionSnapshot>(
      `/api/chat/sessions/${encodeURIComponent(this.sessionId)}/idle`,
      {
        method: "POST",
      },
    );
  }

  async setSessionName(title: string) {
    return await this.request<ServerSessionSnapshot>(
      `/api/chat/sessions/${encodeURIComponent(this.sessionId)}/title`,
      {
        method: "PATCH",
        body: JSON.stringify({ title }),
      },
    );
  }

  async setModel(model: ServerModel | undefined) {
    await this.syncModel(model);
    return this.snapshot();
  }

  async setThinkingLevel(thinkingLevel: ThinkingLevel) {
    await this.syncThinkingLevel(thinkingLevel);
    return this.snapshot();
  }

  dispose() {
    this.eventSource?.close();
    this.eventSource = undefined;
    this.listeners.clear();
  }

  private async syncModel(model: ServerModel | undefined) {
    const previous = this.stateModel;
    this.stateModel = model;

    if (this.suppressStateSync || !model) {
      return;
    }

    try {
      await this.request<ServerSessionSnapshot>(
        `/api/chat/sessions/${encodeURIComponent(this.sessionId)}/model`,
        {
          method: "PATCH",
          body: JSON.stringify({ model }),
        },
      );
    } catch (error) {
      this.stateModel = previous;
      console.error("Failed to update chat model on the server:", error);
    }
  }

  private async syncThinkingLevel(thinkingLevel: ThinkingLevel) {
    const previous = this.stateThinkingLevel;
    this.stateThinkingLevel = thinkingLevel;

    if (this.suppressStateSync) {
      return;
    }

    try {
      await this.request<ServerSessionSnapshot>(
        `/api/chat/sessions/${encodeURIComponent(this.sessionId)}/thinking`,
        {
          method: "PATCH",
          body: JSON.stringify({ thinkingLevel }),
        },
      );
    } catch (error) {
      this.stateThinkingLevel = previous;
      console.error("Failed to update chat thinking level on the server:", error);
    }
  }

  private async request<T>(path: string, init: RequestInit) {
    const response = await fetch(`${env.VITE_SERVER_URL}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = (await response.json()) as T;
    if (this.isSessionSnapshot(data)) {
      this.applySnapshot(data);
    }
    return data;
  }

  private connect() {
    this.eventSource = new EventSource(
      `${env.VITE_SERVER_URL}/api/chat/sessions/${encodeURIComponent(this.sessionId)}/events`,
    );

    this.eventSource.addEventListener("event", (rawEvent) => {
      const event = JSON.parse(
        (rawEvent as MessageEvent<string>).data,
      ) as RemoteSessionEvent;
      this.applyEvent(event);
      void this.emit(event);
    });

    this.eventSource.addEventListener("snapshot", (rawEvent) => {
      const snapshot = JSON.parse(
        (rawEvent as MessageEvent<string>).data,
      ) as ServerSessionSnapshot;
      this.applySnapshot(snapshot);
      void this.emit({ type: "snapshot", snapshot });
    });
  }

  private applyEvent(event: RemoteSessionEvent) {
    if (event.type === "agent_start" || event.type === "turn_start") {
      this.state.isStreaming = true;
      return;
    }

    if (event.type === "message_start") {
      const message = event.message as { role?: string } | undefined;
      if (message?.role && message.role !== "assistant") {
        this.state.messages = [
          ...this.state.messages,
          event.message as { role?: string; content?: unknown },
        ];
      }
      return;
    }

    if (event.type === "message_update") {
      this.state.isStreaming = true;
      this.state.streamingMessage = event.message;
      return;
    }

    if (event.type === "agent_end") {
      this.state.isStreaming = false;
      this.state.streamingMessage = undefined;
    }
  }

  private applySnapshot(snapshot: ServerSessionSnapshot) {
    this.suppressStateSync = true;
    try {
      this.sessionId = snapshot.sessionId;
      this.title = snapshot.title;
      this.stateModel = snapshot.model;
      this.stateThinkingLevel = snapshot.thinkingLevel;
      this.state.messages = [...snapshot.messages];
      this.state.isStreaming = snapshot.isStreaming;
      if (!snapshot.isStreaming) {
        this.state.streamingMessage = undefined;
      }
    } finally {
      this.suppressStateSync = false;
    }
  }

  private snapshot(): ServerSessionSnapshot {
    return {
      sessionId: this.sessionId,
      title: this.title,
      model: this.stateModel,
      thinkingLevel: this.stateThinkingLevel,
      messages: [...this.state.messages],
      isStreaming: this.state.isStreaming,
    };
  }

  private async emit(event: RemoteSessionEvent) {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }

  private isSessionSnapshot(value: unknown): value is ServerSessionSnapshot {
    return (
      typeof value === "object" &&
      value !== null &&
      "sessionId" in value &&
      "messages" in value
    );
  }
}

export function toAgent(session: RemoteChatSession): Agent {
  return session as unknown as Agent;
}

export async function createSession(sessionId?: string) {
  if (sessionId) {
    try {
      const response = await fetch(
        `${env.VITE_SERVER_URL}/api/chat/sessions/${encodeURIComponent(sessionId)}`,
      );
      if (response.ok) {
        return (await response.json()) as ServerSessionSnapshot;
      }
    } catch {
      // fall through and create a new session
    }
  }

  const response = await fetch(`${env.VITE_SERVER_URL}/api/chat/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as ServerSessionSnapshot;
}
