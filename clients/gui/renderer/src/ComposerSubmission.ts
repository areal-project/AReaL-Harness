import { snapShotContext, snapShotAttachmentMeta } from "./snapshots/source.js";
import { consumeSnapShotFiles } from "./snapshots/drafts.js";
import { forgetComposerUploads } from "./ComposerUploadState.js";
import { uploadComposerFiles } from "./ComposerUploads.js";
import {
  composerInput,
  hasMissingComposerFiles,
  type ComposerDraftAttachment,
} from "./ComposerAttachments.js";
import {
  conversationSelectionScope,
  readConversationSelections,
  consumeConversationSelections,
} from "./conversationSelectionReference.js";
import {
  readMcpDraft,
  mcpImageFile,
  mcpDraftImageFiles,
  consumeMcpDraft,
} from "./mcp-app-draft.js";
import {
  revalidateComposerPlugins,
  composerPluginIntent,
  mergeComposerPluginSkills,
} from "./ComposerPlugins.js";
import { composerSkillContent, readComposerSkills } from "./ComposerSkills.js";
import { snapshotImageAnnotations, serializeImageAnnotations } from "./imageAnnotations.js";
import { browserAnnotation, browserAnnotationText } from "./browserAnnotations.js";
import {
  reviewCommentKey,
  attachedReviewComments,
  readReviewComments,
  reviewCommentText,
  recordUnknownReviewSubmission,
  consumeReviewComments,
} from "./reviewComments.js";
import type { Action, Data } from "./services.js";

// Both the first message and later turns use the same attachment and admission path.
export async function submitMessage(
  action: Action,
  projectId: string,
  threadId: string,
  text: string,
  files: ComposerDraftAttachment[],
  options: Data = {},
) {
  if (hasMissingComposerFiles(files))
    throw new Error("Missing draft attachment; reattach or remove it before sending.");
  const reviewKey = reviewCommentKey(projectId, threadId);
  const comments = options.appMessage ? [] : attachedReviewComments(readReviewComments(reviewKey));
  const key = `areal-gui:draft:${projectId}:${threadId}`;
  const selectionScope = conversationSelectionScope(projectId, threadId);
  const capturedReferences = options.appMessage ? [] : readConversationSelections(selectionScope);
  const capturedMcp = options.appMessage ? [] : readMcpDraft(key);
  const blocks = options.appMessage
    ? (options.mcpContent ?? [])
    : capturedMcp.map((entry: Data) => entry.block);
  const imageBlocks = blocks.filter((block: Data) => block.type === "image");
  const uploadOwner = options.uploadOwner ?? JSON.stringify([projectId, threadId]);
  const imageFiles: File[] = options.appMessage
    ? imageBlocks.map(mcpImageFile)
    : mcpDraftImageFiles(key, capturedMcp, uploadOwner, (files: File[]) =>
        forgetComposerUploads(uploadOwner, files),
      );
  try {
    const input = composerInput(text, files);
    const imageSnapshot = snapshotImageAnnotations(input.files);
    const plugins = options.appMessage
      ? []
      : await revalidateComposerPlugins(
          options.skillAction ?? action,
          options.pluginContext ?? { kind: "mainThread", projectId, threadId },
          key,
          input.text,
          options.pluginMessages?.unavailable ?? "chat.composer.pluginReferenceUnavailable",
        );
    const pluginIntent = composerPluginIntent(
      plugins,
      options.pluginMessages?.intent ??
        ((name: string) => `Use the selected plugin ${name} for this request.`),
    );
    const skillContent = options.appMessage
      ? ""
      : await composerSkillContent(
          options.skillAction ?? action,
          projectId,
          threadId,
          mergeComposerPluginSkills(readComposerSkills(key), plugins),
        );
    const attachments = await uploadComposerFiles(
      action,
      projectId,
      threadId,
      [...input.files, ...imageFiles],
      undefined,
      options.uploadOwner,
    );
    imageBlocks.forEach((block: Data, index: number) => {
      if (block._meta) attachments[input.files.length + index]._meta = block._meta;
    });
    input.files.forEach((file, index) => {
      const meta = snapShotAttachmentMeta(file);
      if (meta) attachments[index]._meta = { ...attachments[index]._meta, ...meta };
    });
    const annotationFeedback = input.files
      .flatMap((file, index) => {
        const note = browserAnnotation(file);
        return note ? [browserAnnotationText(note, attachments[index].url)] : [];
      })
      .join("\n\n");
    const feedback = [
      annotationFeedback,
      snapShotContext(input.files, attachments),
      serializeImageAnnotations(imageSnapshot, attachments),
      comments.map(reviewCommentText).join("\n\n"),
      pluginIntent,
      skillContent,
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      options.onSendStart?.();
      await action(options.steer ? "steer" : "send", {
        projectId,
        threadId,
        text: feedback ? (input.text ? `${input.text}\n\n${feedback}` : feedback) : input.text,
        attachments,
        ...(capturedReferences.length
          ? { conversationQuotes: capturedReferences.map(({ text }) => ({ text })) }
          : {}),
        ...(blocks.some((block: Data) => block.type !== "image")
          ? { mcpContent: blocks.filter((block: Data) => block.type !== "image") }
          : {}),
        expectedTurnId: options.expectedTurnId,
        enqueue: options.enqueue === true,
      });
    } catch (cause) {
      const error = cause as Error & { submissionUnknown?: boolean; requestId?: string };
      if (error.submissionUnknown && error.requestId && comments.length) {
        try {
          recordUnknownReviewSubmission(reviewKey, error.requestId, comments);
        } catch {
          error.message += " 评论提交记录无法保存，原评论已保留。"; // raw-error-ok: 补充详情
        }
      }
      throw cause;
    }
    // Only explicit acceptance consumes the captured records. Unknown submissions
    // retain their exact IDs until the existing Core receipt is reconciled.
    await consumeSnapShotFiles(input.files);
    forgetComposerUploads(uploadOwner, [...input.files, ...imageFiles]);
    consumeReviewComments(reviewKey, comments);
    if (!options.appMessage) {
      consumeMcpDraft(key, capturedMcp);
      consumeConversationSelections(selectionScope, capturedReferences);
    }
  } finally {
    if (options.appMessage) forgetComposerUploads(uploadOwner, imageFiles);
  }
}
