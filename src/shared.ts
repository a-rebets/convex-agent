import type { ModelMessage } from "ai";
import type { Message } from "./validators.js";

export const DEFAULT_RECENT_MESSAGES = 100;

export function isTool(message: Message | ModelMessage) {
  return (
    message.role === "tool" ||
    (message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some((c) => c.type === "tool-call"))
  );
}

export function extractText(message: Message | ModelMessage) {
  switch (message.role) {
    case "user":
      if (typeof message.content === "string") {
        return message.content;
      }
      return message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
    case "assistant":
      if (typeof message.content === "string") {
        return message.content;
      }
      return message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
    case "system":
      return message.content;
    // we don't extract text from tool messages
  }
  return undefined;
}

export const DEFAULT_MESSAGE_RANGE = { before: 2, after: 1 };

export function sorted<T extends { order: number; stepOrder: number }>(
  messages: T[],
  order: "asc" | "desc" = "asc",
): T[] {
  return [...messages].sort(
    order === "asc"
      ? (a, b) => a.order - b.order || a.stepOrder - b.stepOrder
      : (a, b) => b.order - a.order || b.stepOrder - a.stepOrder,
  );
}
