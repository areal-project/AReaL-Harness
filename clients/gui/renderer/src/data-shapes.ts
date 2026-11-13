import type { Data } from "./services.js";

export const dataItems = (value: unknown): Data[] => (Array.isArray(value) ? value : []);

export const recordItems = (value: unknown): Data[] =>
  dataItems(value).filter(
    (item) => item !== null && typeof item === "object" && !Array.isArray(item),
  );

export const stringItems = (value: unknown): string[] =>
  dataItems(value).filter((item) => typeof item === "string") as string[];

export const queueItems = (queue: Data): Data[] => (Array.isArray(queue.items) ? queue.items : []);

export const queueInput = (item: Data): Data[] => (Array.isArray(item.input) ? item.input : []);

export const queueText = (item: Data) =>
  queueInput(item)
    .map((part: Data) => (part.type === "text" ? part.text : "[附件]"))
    .join("\n");

export const remoteQueueInput = (item: Data): Data[] =>
  Array.isArray(item.input) ? item.input : [];

export const channelQuestions = (message: Data): Data[] =>
  Array.isArray(message.questions) ? message.questions : [];

export const channelQuestionOptions = (question: Data): string[] =>
  Array.isArray(question.options)
    ? question.options.filter((option: unknown): option is string => typeof option === "string")
    : [];

export const goalReportItems = (value: unknown): string[] => stringItems(value);
