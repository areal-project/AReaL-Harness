import type { Data, Action } from "./services.js";
import { isSnapShotDecoration, sentSnapShots } from "./snapshots/source.js";
import { sentReviewFeedback } from "./reviewComments.js";
import { SentReviewComments } from "./ReviewCommentViews.js";
import { McpContentLabel } from "./McpComposerAttachments.js";
import { SentBrowserAnnotations } from "./BrowserAnnotationAttachments.js";
import { sentBrowserAnnotations } from "./browserAnnotations.js";
import { sentImageAnnotations } from "./imageAnnotations.js";
import { ImageAnnotationList } from "./ImageAnnotationViews.js";
import { SentAttachment } from "./MessageAttachment.js";
import { CollapsibleText } from "./CollapsibleText.js";
import { UserMessageBody } from "./UserMessageBody.js";
import { MessageTime } from "./ConversationTimeline.js";
import { MessageActions } from "./MessageActions.js";
import { UserPromptEdit } from "./UserPromptEdit.js";

/** 时间线里已发送的用户消息：附件、批注、折叠正文与编辑入口。 */
export function SentUserMessage({
  item,
  owner,
  project,
  localThread,
  action,
  dark,
  editable,
  onLink,
  onFile,
  onExpand,
}: {
  item: Data;
  owner: string;
  project: Data;
  localThread: Data;
  action: Action;
  dark: boolean;
  editable: boolean;
  onLink?: (url: string) => void;
  onFile?: (path: string, line?: number) => void;
  onExpand: () => void;
}) {
  const content = item.content ?? [];
  const imageParts = content.filter((part: Data) => part.type === "image");
  const decorations = content
    .filter((part: Data) => part.type === "text" && part.mcpContent)
    .map((part: Data) => part.mcpContent);
  const appContent = content.filter(
    (part: Data) =>
      part.type === "text" && part.mcpContent && !isSnapShotDecoration(part.mcpContent, imageParts),
  );
  const text = content
    .filter((part: Data) => part.type === "text" && !part.mcpContent)
    .map((part: Data) => part.text ?? "")
    .join("\n");
  const feedback = sentReviewFeedback(text);
  const attachments: Data[] = content.filter((part: Data) => part.type !== "text");
  const browserFeedback = sentBrowserAnnotations(feedback.text, attachments);
  const snapshotFeedback = sentSnapShots(browserFeedback.text, attachments, decorations);
  const imageFeedback = sentImageAnnotations(snapshotFeedback.text, attachments);
  const ordinaryAttachments = attachments
    .map((part: Data, index: number) => ({ part, index }))
    .filter(
      ({ part }) => !browserFeedback.notes.some((note) => note.imageUri === (part.url ?? part.uri)),
    );
  return (
    <div className="user-message" data-side-item-id={item.id}>
      <div className="user-message-content">
        <SentReviewComments comments={feedback.comments} />
        {appContent.length > 0 && (
          <div className="user-attachments" aria-label="应用内容">
            {appContent.map((part: Data, index: number) => (
              <McpContentLabel key={index} block={part.mcpContent} />
            ))}
          </div>
        )}
        <SentBrowserAnnotations
          notes={browserFeedback.notes}
          attachments={attachments}
          projectId={project.id}
          threadId={localThread.id}
          action={action}
        />
        {ordinaryAttachments.length > 0 ? (
          <div className="user-attachments" data-testid="user-attachments">
            {ordinaryAttachments.map(({ part, index }) => {
              const note = imageFeedback.notes.find((note) => note.attachmentIndex === index);
              return (
                <div key={`${index}:${part.url ?? part.uri}`} className="flex flex-col gap-2">
                  <SentAttachment
                    part={part}
                    annotation={note}
                    snapShotSource={
                      snapshotFeedback.notes.find(
                        (record) => record.imageUri === (part.url ?? part.uri),
                      )?.source
                    }
                    projectId={project.id}
                    threadId={localThread.id}
                    action={action}
                  />
                  {note && <ImageAnnotationList note={note} />}
                </div>
              );
            })}
          </div>
        ) : null}
        {imageFeedback.text.trim() ? (
          <div className="user-bubble">
            <CollapsibleText key={`${owner}:${item.id}`} onExpandedChange={onExpand}>
              <UserMessageBody
                fileReferenceRoot={localThread.worktree?.directory ?? project.root}
                theme={dark ? "dark" : "light"}
                onOpenExternalUrl={onLink}
                onOpenFileLink={onFile}
              >
                {imageFeedback.text}
              </UserMessageBody>
            </CollapsibleText>
          </div>
        ) : null}
        <MessageTime createdAt={item.createdAt} />
        {(text.trim() || editable) && (
          <MessageActions text={text}>
            {editable && (
              <UserPromptEdit
                key={`${owner}:${item.id}`}
                project={project}
                thread={localThread}
                item={item}
                action={action}
              />
            )}
          </MessageActions>
        )}
      </div>
    </div>
  );
}
