import { Container, Editor, Loader, Markdown, matchesKey, Text, TUI, type Focusable } from "@earendil-works/pi-tui";
import type { ChatClient } from "../chat/chat-client";
import { loginChatGpt } from "../auth/chatgpt-auth";
import { chalk, editorTheme, markdownTheme } from "./theme";

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

export class ChatApp {
  private readonly transcript = new Container();
  private readonly editor: Editor;
  private readonly loader: Loader;
  private waiting = false;

  constructor(
    private readonly tui: TUI,
    private readonly chatClient: ChatClient,
  ) {
    this.editor = new Editor(tui, editorTheme);
    this.loader = new Loader(tui, chalk.cyan, chalk.dim, "Thinking...");
  }

  start(): void {
    this.tui.addChild(new Text(chalk.bold("PI Chat"), 1, 0));
    this.tui.addChild(new Text(chalk.dim("ChatGPT Codex: gpt-5.5"), 1, 0));
    this.tui.addChild(this.transcript);
    this.tui.addChild(this.editor);
    this.tui.setFocus(this.editor);
    this.bindInput();
    this.tui.addInputListener((data) => {
      if (!matchesKey(data, "ctrl+c")) return undefined;
      this.tui.stop();
      return { consume: true };
    });
    this.tui.start();
  }

  private addMessage(role: string, content: string): Markdown {
    const label = role === "user" ? chalk.cyan("You") : role === "error" ? chalk.red("Error") : chalk.green("Assistant");
    const message = new Markdown(`${label}\n\n${content}`, 1, 1, markdownTheme);
    this.transcript.addChild(message);
    this.tui.requestRender();
    return message;
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

  private bindInput(): void {
    this.editor.onSubmit = (value) => {
      void this.submit(value);
    };
  }

  private async submit(value: string): Promise<void> {
    const text = value.trim();
    if (!text || this.waiting) return;

    if (text === "/login") {
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

    this.waiting = true;
    this.editor.disableSubmit = true;
    this.addMessage("user", text);

    this.transcript.addChild(this.loader);
    const assistant = this.addMessage("assistant", "...");
    let responseText = "";

    try {
      const result = await this.chatClient.sendMessage(text, (delta) => {
        responseText += delta;
        assistant.setText(`${chalk.green("Assistant")}\n\n${responseText}`);
        this.tui.requestRender();
      });

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
