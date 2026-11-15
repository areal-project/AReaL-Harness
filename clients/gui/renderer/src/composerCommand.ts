import type { Data } from "./services.js";

export type ComposerContextPart = {
  kind: "conversationQuote";
  text: string;
  sourceSessionId?: string;
  sourceRowId?: string;
};

export type ComposerCommand =
  | { kind: "send"; threadId: string; enqueue: boolean }
  | { kind: "steer"; threadId: string; expectedTurnId: string }
  | { kind: "queueEdit"; threadId: string; queueItemId: string; expectedRevision: number }
  | { kind: "sideSend"; threadId: string; sourceThreadId: string };

export type ComposerSubmission = {
  action: "send" | "steer";
  params: Data;
};

export function commandForSubmission(command: ComposerCommand, base: Data): ComposerSubmission {
  switch (command.kind) {
    case "send":
      return {
        action: "send",
        params: { ...base, threadId: command.threadId, enqueue: command.enqueue },
      };
    case "steer":
      return {
        action: "steer",
        params: {
          ...base,
          threadId: command.threadId,
          expectedTurnId: command.expectedTurnId,
        },
      };
    case "queueEdit":
      return {
        action: "send",
        params: {
          ...base,
          threadId: command.threadId,
          queueItemId: command.queueItemId,
          expectedRevision: command.expectedRevision,
        },
      };
    case "sideSend":
      return {
        action: "send",
        params: {
          ...base,
          threadId: command.threadId,
          sourceThreadId: command.sourceThreadId,
        },
      };
  }
}

export function conversationQuotes(parts: readonly ComposerContextPart[]) {
  return parts
    .filter((part) => part.kind === "conversationQuote" && part.text.trim())
    .map((part) => ({ text: part.text }));
}
