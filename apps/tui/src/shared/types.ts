export type ChatRole = "user" | "assistant" | "error";

export interface ChatMessageView {
  role: ChatRole;
  content: string;
}
