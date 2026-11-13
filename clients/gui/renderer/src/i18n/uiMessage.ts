import type { MessageId } from "./messages.js";

// 不依赖 React 的部分，供非组件模块（如 errors/errorCopy.ts）使用。
export type MessageValues = Record<string, string | number | boolean | Date | null | undefined>;
export type Translate = (id: MessageId, values?: MessageValues) => string;
export type UiMessage = { id: MessageId; values?: MessageValues };

export class UiMessageError extends Error {
  constructor(public readonly descriptor: UiMessage) {
    super(descriptor.id);
    this.name = "UiMessageError";
  }
}
