import type { ComposerDraftAttachment } from "./ComposerAttachments.js";

export const attachmentDrafts = new Map<string, ComposerDraftAttachment[]>();

export const sending = new Set<string>();
