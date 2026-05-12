import { CombinedAutocompleteProvider, Container, Editor, fuzzyFilter, getKeybindings, Input, Loader, Markdown, matchesKey, Text, TUI, type Focusable, type SlashCommand } from "@earendil-works/pi-tui"
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ToolExecutionComponent, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, Component } from "@earendil-works/pi-tui";
import type { ChatClient } from "../chat/chat-client";
import { loginChatGpt, logoutChatGpt } from "../auth/chatgpt-auth";
import { chalk, editorTheme, markdownTheme } from "./theme";

const reasoningOptions: Array<{ level: ModelThinkingLevel; label: string }> = [
  { level: "off", label: "No thinking" },
  { level: "low", label: "Low" },
  { level: "medium", label: "Medium" },
  { level: "high", label: "High" },
  { level: "xhigh", label: "Extra high" },
];

const slashCommands: SlashCommand[] = [
  { name: "logout", description: "Remove provider authentication" },
  { name: "login", description: "Configure provider authentication" },
  { name: "model", description: "Select model (opens selector UI)" },
];

function colorTheme() {
  return {
    fg: (color: string, text: string) => {
      if (color === "accent") return chalk.cyan(text);
      if (color === "muted" || color === "dim") return chalk.dim(text);
      if (color === "success") return chalk.green(text);
      if (color === "warning") return chalk.yellow(text);
      if (color === "error") return chalk.red(text);
      return text;
    },
    bg: (_color: string, text: string) => text,
    bold: (text: string) => chalk.bold(text),
    italic: (text: string) => chalk.italic(text),
    underline: (text: string) => chalk.underline(text),
    inverse: (text: string) => chalk.inverse(text),
    strikethrough: (text: string) => chalk.strikethrough(text),
  };
}

class LoginProviderSelector extends Container implements Focusable {
  focused = false;

  constructor(
    private readonly onSelect: () => void,
    private readonly onCancel: () => void,
  ) {
    super();
    this.addChild(new Text(chalk.bold("Select provider to configure:"), 1, 0));
    this.addChild(new Text(`${chalk.cyan(">")} ${chalk.cyan("ChatGPT Codex")} ${chalk.dim("openai-codex")}`, 1, 0));
    this.addChild(new Text(chalk.dim("Press Enter to login, Esc to cancel."), 1, 0));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "enter")) this.onSelect();
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onCancel();
  }
}

class ModelSelector extends Container implements Focusable {
  private readonly searchInput = new Input();
  private readonly list = new Container();
  private filteredModels: Model<any>[];
  private selectedModelIndex = 0;

  focused = false;

  constructor(
    private readonly models: Model<any>[],
    private readonly currentModelId: string,
    private readonly onSelect: (modelId: string) => void,
    private readonly onCancel: () => void,
  ) {
    super();
    this.filteredModels = models;
    const modelIndex = models.findIndex((model) => model.id === currentModelId);
    this.selectedModelIndex = modelIndex >= 0 ? modelIndex : 0;
    this.searchInput.onSubmit = () => this.selectCurrent();

    this.addChild(new Text(chalk.bold("Select model:"), 1, 0));
    this.addChild(this.searchInput);
    this.addChild(this.list);
    this.updateList();
  }

  private filterModels(): void {
    const query = this.searchInput.getValue();
    this.filteredModels = query
      ? fuzzyFilter(this.models, query, (model) => `${model.id} ${model.name} ${model.provider}/${model.id}`)
      : this.models;
    this.selectedModelIndex = Math.min(this.selectedModelIndex, Math.max(0, this.filteredModels.length - 1));
    this.updateList();
  }

  private updateList(): void {
    this.list.clear();
    const visibleModels = this.filteredModels.slice(0, 10);
    for (const [index, model] of visibleModels.entries()) {
      const selected = index === this.selectedModelIndex;
      const current = model.id === this.currentModelId ? chalk.green(" ✓") : "";
      const prefix = selected ? chalk.cyan("> ") : "  ";
      this.list.addChild(new Text(`${prefix}${model.id}${current}`, 1, 0));
    }
    this.list.addChild(new Text("", 1, 0));
    this.list.addChild(new Text(chalk.dim("Up/down model, Enter select, Esc cancel."), 1, 0));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up")) this.selectedModelIndex = Math.max(0, this.selectedModelIndex - 1);
    else if (matchesKey(data, "down")) this.selectedModelIndex = Math.min(this.filteredModels.length - 1, this.selectedModelIndex + 1);
    else if (matchesKey(data, "enter")) this.selectCurrent();
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onCancel();
    else {
      this.searchInput.handleInput(data);
      this.filterModels();
      return;
    }
    this.updateList();
  }

  private selectCurrent(): void {
    const model = this.filteredModels[this.selectedModelIndex];
    if (model) this.onSelect(model.id);
  }
}

class RightAlignedText {
  private text = "";

  setText(text: string): void {
    this.text = text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const padding = Math.max(0, width - this.text.length - 1);
    return [`${" ".repeat(padding)}${this.text} `];
  }
}

export class ChatApp {
  private readonly transcript = new Container();
  private readonly editor: Editor;
  private readonly loader: Loader;
  private readonly modelStatus: RightAlignedText;
  private readonly toolMessages = new Map<string, ToolExecutionComponent>();
  private waiting = false;

  constructor(
    private readonly tui: TUI,
    private readonly chatClient: ChatClient,
  ) {
    this.editor = new Editor(tui, editorTheme);
    const skillCommands = chatClient.getLoadedResources().skills.map((name) => ({
      name: `skill:${name}`,
      description: "Invoke loaded skill",
    }));
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...slashCommands, ...skillCommands], process.cwd()));
    this.loader = new Loader(tui, chalk.cyan, chalk.dim, "Thinking...");
    this.modelStatus = new RightAlignedText();
  }

  start(): void {
    this.tui.addChild(new Text(chalk.bold("PI Chat"), 1, 0));
    this.addLoadedResources();
    this.updateModelStatus();
    this.tui.addChild(this.transcript);
    this.tui.addChild(this.editor);
    this.tui.addChild(this.modelStatus);
    this.tui.setFocus(this.editor);
    this.bindInput();
    this.tui.addInputListener((data) => {
      if (matchesKey(data, "shift+tab") && this.editor.focused && !this.waiting) {
        void this.cycleReasoning();
        return { consume: true };
      }
      if (!matchesKey(data, "ctrl+c")) return undefined;
      this.tui.stop();
      return { consume: true };
    });
    this.tui.start();
  }

  createExtensionUIContext(): ExtensionUIContext {
    const theme = colorTheme();
    return {
      custom: (factory) => this.showExtensionComponent(factory, theme),
      notify: (message, type) => type === "error" ? this.addMessage("error", message) : this.showStatus(message),
      pasteToEditor: (text) => this.editor.insertTextAtCursor(text),
      setEditorText: (text) => this.editor.setText(text),
      getEditorText: () => this.editor.getText(),
      get theme() {
        return theme as any;
      },
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      onTerminalInput: () => () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => this.tui.terminal.setTitle(title),
      editor: async () => undefined,
      addAutocompleteProvider: (_factory: (current: AutocompleteProvider) => AutocompleteProvider) => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not available in this TUI." }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private showExtensionComponent<T>(
    factory: Parameters<ExtensionUIContext["custom"]>[0],
    theme: ReturnType<typeof colorTheme>,
  ): Promise<T> {
    const savedText = this.editor.getText();
    const typedFactory = factory as (
      tui: TUI,
      theme: ReturnType<typeof colorTheme>,
      keybindings: ReturnType<typeof getKeybindings>,
      done: (result: T) => void,
    ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;
    return new Promise((resolve, reject) => {
      let component: (Component & { dispose?(): void }) | undefined;
      let closed = false;
      const finish = (result: T) => {
        if (closed) return;
        closed = true;
        if (component) this.tui.removeChild(component);
        this.editor.setText(savedText);
        this.tui.setFocus(this.editor);
        this.tui.requestRender();
        component?.dispose?.();
        resolve(result);
      };

      Promise.resolve(typedFactory(this.tui, theme, getKeybindings(), finish))
        .then((created) => {
          if (closed) return;
          component = created;
          const editorIndex = this.tui.children.indexOf(this.editor);
          this.tui.children.splice(editorIndex, 0, component);
          this.tui.setFocus(component);
          this.tui.requestRender();
        })
        .catch((error) => {
          if (closed) return;
          this.editor.setText(savedText);
          this.tui.setFocus(this.editor);
          this.tui.requestRender();
          reject(error);
        });
    });
  }

  private addLoadedResources(): void {
    const loaded = this.chatClient.getLoadedResources();
    if (loaded.skills.length > 0) this.tui.addChild(new Text(`${chalk.bold("[Skills]")}\n  ${loaded.skills.join(", ")}`, 1, 0));
    if (loaded.extensions.length > 0) this.tui.addChild(new Text(`${chalk.bold("[Extensions]")}\n  ${loaded.extensions.join(", ")}`, 1, 0));
  }

  private addSkillInvocation(name: string): void {
    const loaderIndex = this.transcript.children.indexOf(this.loader);
    const message = new Text(`${chalk.bold("[skill]")} ${chalk.cyan(name)} ${chalk.dim("(expanded)")}`, 1, 1);
    if (loaderIndex >= 0) this.transcript.children.splice(loaderIndex, 0, message);
    else this.transcript.addChild(message);
    this.tui.requestRender();
  }

  private setToolInvocation(tool: { id: string; name: string; args?: any; result?: any; isError?: boolean; status: "start" | "end" }): void {
    let message = this.toolMessages.get(tool.id);
    if (!message) {
      message = new ToolExecutionComponent(tool.name, tool.id, tool.args ?? {}, {}, this.chatClient.getToolDefinition(tool.name), this.tui, process.cwd());
      this.toolMessages.set(tool.id, message);
      const loaderIndex = this.transcript.children.indexOf(this.loader);
      if (loaderIndex >= 0) this.transcript.children.splice(loaderIndex, 0, message);
      else this.transcript.addChild(message);
    }
    if (tool.status === "start") message.markExecutionStarted();
    if (tool.status === "end") {
      message.updateResult({ ...tool.result, isError: tool.isError ?? false });
      this.toolMessages.delete(tool.id);
    }
    this.tui.requestRender();
  }

  private addMessage(role: string, content: string): Markdown {
    const label = role === "user" ? chalk.cyan("You") : role === "error" ? chalk.red("Error") : chalk.green("Assistant");
    const message = new Markdown(`${label}\n\n${content}`, 1, 1, markdownTheme);
    this.transcript.addChild(message);
    this.tui.requestRender();
    return message;
  }

  private updateModelStatus(): void {
    const text = `${this.chatClient.getModelId()} • ${this.chatClient.getReasoningLevel()}`;
    this.modelStatus.setText(chalk.dim(text));
  }

  private async cycleReasoning(): Promise<void> {
    const current = this.chatClient.getReasoningLevel();
    const currentIndex = reasoningOptions.findIndex((option) => option.level === current);
    const next = reasoningOptions[(currentIndex + 1) % reasoningOptions.length];
    if (!next) return;
    await this.chatClient.setModel(this.chatClient.getModelId(), next.level);
    this.updateModelStatus();
    this.tui.requestRender();
  }

  async prompt(message: string): Promise<string> {
    this.addMessage("assistant", message);
    return new Promise((resolve) => {
      this.editor.onSubmit = (value) => {
        this.bindInput();
        resolve(value);
      };
    });
  }

  showStatus(message: string): void {
    this.addMessage("assistant", message);
  }

  private selectLoginProvider(): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (selected: boolean) => {
        this.tui.removeChild(selector);
        this.tui.setFocus(this.editor);
        this.tui.requestRender();
        resolve(selected);
      };
      const selector = new LoginProviderSelector(() => done(true), () => done(false));
      const editorIndex = this.tui.children.indexOf(this.editor);
      this.tui.children.splice(editorIndex, 0, selector);
      this.tui.setFocus(selector);
      this.tui.requestRender();
    });
  }

  private selectModel(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.tui.removeChild(selector);
        this.tui.setFocus(this.editor);
        this.tui.requestRender();
        resolve();
      };
      const selector = new ModelSelector(
        this.chatClient.getAvailableModels(),
        this.chatClient.getModelId(),
        (modelId) => {
          void this.chatClient.setModel(modelId, this.chatClient.getReasoningLevel()).then(() => {
            this.updateModelStatus();
            this.showStatus(`Model: ${modelId}`);
            done();
          });
        },
        done,
      );
      const editorIndex = this.tui.children.indexOf(this.editor);
      this.tui.children.splice(editorIndex, 0, selector);
      this.tui.setFocus(selector);
      this.tui.requestRender();
    });
  }

  private bindInput(): void {
    this.editor.onSubmit = (value) => {
      void this.submit(value);
    };
  }

  private async submit(value: string): Promise<void> {
    const text = value.trim();
    if (!text || this.waiting) return;

    if (text === "/login" || text.startsWith("/login ")) {
      const selected = await this.selectLoginProvider();
      if (!selected) return;

      try {
        await loginChatGpt({
          onStatus: (message) => this.showStatus(message),
          onPrompt: (message) => this.prompt(message),
        });
        this.showStatus("ChatGPT OAuth login complete.");
      } catch (error) {
        this.addMessage("error", error instanceof Error ? error.message : "Login failed");
      }
      this.bindInput();
      return;
    }

    if (text === "/model" || text.startsWith("/model ")) {
      await this.selectModel();
      return;
    }

    if (text === "/logout" || text.startsWith("/logout ")) {
      await logoutChatGpt();
      this.showStatus("Removed ChatGPT Codex authentication.");
      return;
    }

    this.waiting = true;
    this.editor.disableSubmit = true;
    this.addMessage("user", text);

    this.transcript.addChild(this.loader);
    const assistant = this.addMessage("assistant", "...");
    let responseText = "";

    try {
      const result = await this.chatClient.sendMessage(
        text,
        (delta) => {
          responseText += delta;
          assistant.setText(`${chalk.green("Assistant")}\n\n${responseText}`);
          this.tui.requestRender();
        },
        (skill) => this.addSkillInvocation(skill.name),
        (tool) => this.setToolInvocation(tool),
      );

      assistant.setText(`${chalk.green("Assistant")}\n\n${result.content || responseText}`);
    } catch (error) {
      assistant.setText(`${chalk.red("Error")}\n\n${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      this.transcript.removeChild(this.loader);
      this.waiting = false;
      this.editor.disableSubmit = false;
      this.tui.requestRender();
    }
  }
}
