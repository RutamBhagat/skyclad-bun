import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { ChatClient } from "./chat/chat-client";
import { ChatApp } from "./ui/chat-app";

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);

let app: ChatApp;
const chatClient = new ChatClient({
  onStatus: (message) => app.showStatus(message),
  onPrompt: (message) => app.prompt(message),
});

await chatClient.loadSettings();
app = new ChatApp(tui, chatClient);
app.start();
