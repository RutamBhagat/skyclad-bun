import { env } from "@skyclad-bun/env/web";
import type { AgentEvent, AgentMessage, AgentState } from "@earendil-works/pi-agent-core";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type RemoteSessionEvent = AgentEvent | {
  type: "snapshot";
  snapshot: ServerSessionSnapshot;
};

export type ServerSessionSnapshot = {
  sessionId: string;
  title: string;
  state: Pick<AgentState, "systemPrompt" | "model" | "thinkingLevel" | "messages">;
  isStreaming: boolean;
  usage: {
    cost: number;
    usingSubscription: boolean;
  };
};

export type ServerSessionListItem = {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export class RemoteChatSession {
  public state: AgentState;
  public usage: ServerSessionSnapshot["usage"];
  public streamFn?: unknown;
  public getApiKey?: unknown;

  private listeners = new Set<(event: RemoteSessionEvent) => void | Promise<void>>();
  private abortController?: AbortController;
  private idlePromise?: Promise<void>;
  private title: string;
  private suppressStateSync = false;

  constructor(
    public sessionId: string,
    snapshot: ServerSessionSnapshot,
  ) {
    this.title = snapshot.title;
    this.usage = snapshot.usage;
    this.state = {
      systemPrompt: snapshot.state.systemPrompt,
      model: snapshot.state.model,
      thinkingLevel: snapshot.state.thinkingLevel as ThinkingLevel,
      tools: [],
      messages: [...snapshot.state.messages],
      isStreaming: snapshot.isStreaming,
      streamingMessage: undefined,
      pendingToolCalls: new Set(),
      errorMessage: undefined,
    } as AgentState;

    let model = this.state.model;
    let thinkingLevel = this.state.thinkingLevel;
    let systemPrompt = this.state.systemPrompt;

    Object.defineProperties(this.state, {
      model: {
        enumerable: true,
        configurable: true,
        get: () => model,
        set: (nextModel: AgentState["model"]) => {
          model = nextModel;
          void this.syncState({ model: nextModel });
        },
      },
      thinkingLevel: {
        enumerable: true,
        configurable: true,
        get: () => thinkingLevel,
        set: (nextThinkingLevel: ThinkingLevel) => {
          thinkingLevel = nextThinkingLevel;
          void this.syncState({ thinkingLevel: nextThinkingLevel });
        },
      },
      systemPrompt: {
        enumerable: true,
        configurable: true,
        get: () => systemPrompt,
        set: (nextSystemPrompt: string) => {
          systemPrompt = nextSystemPrompt;
          void this.syncState({ systemPrompt: nextSystemPrompt });
        },
      },
    });
  }

  subscribe(listener: (event: RemoteSessionEvent) => void | Promise<void>) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(input: string | AgentMessage | AgentMessage[]) {
    if (this.state.isStreaming) {
      throw new Error("Agent is already processing.");
    }

    this.abortController = new AbortController();
    this.setStreaming(true);

    this.idlePromise = this.readPromptStream(input, this.abortController.signal)
      .catch((error) => {
        this.patchReadonlyState({
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        this.setStreaming(false);
        this.abortController = undefined;
      });

    await this.idlePromise;
  }

  async continue() {
    await this.prompt({
      role: "user",
      content: "Continue.",
      timestamp: Date.now(),
    } as AgentMessage);
  }

  abort() {
    this.abortController?.abort();
    void fetch(`${env.VITE_SERVER_URL}/api/agent/sessions/${encodeURIComponent(this.sessionId)}/abort`, {
      method: "POST",
    });
    this.setStreaming(false);
  }

  waitForIdle() {
    return this.idlePromise ?? Promise.resolve();
  }

  reset() {
    this.state.messages = [];
    this.setStreaming(false);
  }

  steer(message: AgentMessage) {
    void this.prompt(message);
  }

  followUp(message: AgentMessage) {
    void this.prompt(message);
  }

  clearSteeringQueue() {}
  clearFollowUpQueue() {}
  clearAllQueues() {}
  hasQueuedMessages() {
    return false;
  }

  async setSessionName(title: string) {
    const snapshot = await this.request<ServerSessionSnapshot>(
      `/api/agent/sessions/${encodeURIComponent(this.sessionId)}/title`,
      {
        method: "PATCH",
        body: JSON.stringify({ title }),
      },
    );
    this.applySnapshot(snapshot);
    return snapshot;
  }

  dispose() {
    this.abortController?.abort();
    this.listeners.clear();
  }

  private async syncState(patch: Partial<Pick<AgentState, "model" | "thinkingLevel" | "systemPrompt">>) {
    if (this.suppressStateSync) return;

    try {
      await this.request(
        `/api/agent/sessions/${encodeURIComponent(this.sessionId)}/state`,
        {
          method: "PATCH",
          body: JSON.stringify(patch),
        },
      );
    } catch (error) {
      console.error("Failed to update agent state on the server:", error);
    }
  }

  private async readPromptStream(message: unknown, signal: AbortSignal) {
    const response = await fetch(
      `${env.VITE_SERVER_URL}/api/agent/sessions/${encodeURIComponent(this.sessionId)}/prompt`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
        signal,
      },
    );

    if (!response.ok || !response.body) {
      throw new Error(await response.text());
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const line = frame.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;

        const event = JSON.parse(line.slice("data: ".length)) as RemoteSessionEvent | { type: "done" } | { type: "server_error"; error: string };

        if (event.type === "done") return;
        if (event.type === "server_error") throw new Error(event.error);

        this.applyEvent(event);
        await this.emit(event);
      }
    }
  }

  private applyEvent(event: RemoteSessionEvent) {
    if (event.type === "snapshot") {
      this.applySnapshot(event.snapshot);
      return;
    }

    switch (event.type) {
      case "agent_start":
      case "turn_start":
        this.setStreaming(true);
        break;

      case "message_update":
        this.patchReadonlyState({ streamingMessage: event.message });
        break;

      case "message_end":
        this.patchReadonlyState({ streamingMessage: undefined });
        this.state.messages = [...this.state.messages, event.message];
        break;

      case "tool_execution_start": {
        const pending = new Set(this.state.pendingToolCalls);
        pending.add(event.toolCallId);
        this.patchReadonlyState({ pendingToolCalls: pending });
        break;
      }

      case "tool_execution_end": {
        const pending = new Set(this.state.pendingToolCalls);
        pending.delete(event.toolCallId);
        this.patchReadonlyState({ pendingToolCalls: pending });
        break;
      }

      case "agent_end":
        this.patchReadonlyState({ streamingMessage: undefined });
        break;
    }
  }

  private applySnapshot(snapshot: ServerSessionSnapshot) {
    this.suppressStateSync = true;
    try {
      this.sessionId = snapshot.sessionId;
      this.title = snapshot.title;
      this.state.systemPrompt = snapshot.state.systemPrompt;
      this.state.model = snapshot.state.model;
      this.state.thinkingLevel = snapshot.state.thinkingLevel;
      this.state.messages = [...snapshot.state.messages];
      this.usage = snapshot.usage;
      this.patchReadonlyState({
        isStreaming: snapshot.isStreaming,
        streamingMessage: snapshot.isStreaming ? this.state.streamingMessage : undefined,
      });
    } finally {
      this.suppressStateSync = false;
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

    return (await response.json()) as T;
  }

  private async emit(event: RemoteSessionEvent) {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }

  private setStreaming(value: boolean) {
    this.patchReadonlyState({
      isStreaming: value,
      streamingMessage: value ? this.state.streamingMessage : undefined,
      pendingToolCalls: value ? this.state.pendingToolCalls : new Set<string>(),
    });
  }

  private patchReadonlyState(patch: Partial<AgentState>) {
    Object.assign(this.state as any, patch);
  }
}

export async function listSessions() {
  const response = await fetch(`${env.VITE_SERVER_URL}/api/agent/sessions`);

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const body = (await response.json()) as { sessions: ServerSessionListItem[] };
  return body.sessions;
}

export async function deleteSession(sessionId: string) {
  const response = await fetch(
    `${env.VITE_SERVER_URL}/api/agent/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }
}

export async function loadSessionSnapshot(sessionId: string) {
  const response = await fetch(
    `${env.VITE_SERVER_URL}/api/agent/sessions/${encodeURIComponent(sessionId)}`,
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as ServerSessionSnapshot;
}

export async function createSession(sessionId?: string) {
  if (sessionId) {
    try {
      return await loadSessionSnapshot(sessionId);
    } catch {
      // fall through and create a new session
    }
  }

  const response = await fetch(`${env.VITE_SERVER_URL}/api/agent/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as ServerSessionSnapshot;
}
