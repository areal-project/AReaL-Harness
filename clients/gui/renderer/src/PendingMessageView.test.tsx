import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { PendingMessageView } from "./UserMessageBody.js";
import { SentAttachment } from "./MessageAttachment.js";
import type { Action } from "./services.js";

vi.mock("./i18n/IntlProvider.js", () => ({
  useI18n: () => ({
    t: (id: string, values?: Record<string, unknown>) =>
      values && "seconds" in values ? `${id}:${values.seconds}` : id,
  }),
}));
vi.mock("./components/ai-elements/message.js", () => ({
  MessageResponse: ({ children }: { children: string }) => <div>{children}</div>,
}));

describe("pending message attachments", () => {
  it("retains an image tile while accepted media is loading", () => {
    const html = renderToStaticMarkup(
      <SentAttachment
        part={{ type: "image", name: "image.png", url: "areal://blob/image" }}
        projectId="project"
        threadId="thread"
        action={vi.fn<Action>() as Action}
      />,
    );
    expect(html).toContain('data-message-attachment="image"');
    expect(html).not.toContain('src=""');
  });

  it("keeps a file tile in place while media loads without offering download", () => {
    const html = renderToStaticMarkup(
      <SentAttachment
        part={{ type: "file", name: "file.txt", url: "areal://blob/file" }}
        projectId="project"
        threadId="thread"
        action={vi.fn<Action>() as Action}
      />,
    );
    expect(html).toContain('data-message-attachment="file"');
    expect(html).toContain("file.txt");
    expect(html).not.toContain("下载附件 file.txt");
  });

  it("renders the image and text together instead of only the filename", () => {
    const html = renderToStaticMarkup(
      <PendingMessageView
        message={{
          text: "Analyze this image",
          files: [new File(["image"], "image.png", { type: "image/png" })],
          previousUserIds: [],
          starting: true,
        }}
      />,
    );
    expect(html).toContain('data-message-attachment="image"');
    expect(html).toContain("Analyze this image");
    expect(html).not.toContain("移除附件");
    // 正文气泡与已发送用户消息保持同一排版类，避免 whitespace-pre-wrap 造成发送交接时高度抖动。
    expect(html).not.toContain("whitespace-pre-wrap");
  });

  it("renders Cloud sandbox elapsed seconds during startup and ready-sending handoff", () => {
    const startingHtml = renderToStaticMarkup(
      <PendingMessageView
        message={{
          text: "Start cloud task",
          files: [],
          previousUserIds: [],
          starting: true,
          status: "cloud.startingSandbox",
          startedAt: Date.now() - 12_000,
        }}
      />,
    );
    expect(startingHtml).toContain("Start cloud task");
    expect(startingHtml).toContain("cloud.startingSandboxElapsed:12");

    const readyHtml = renderToStaticMarkup(
      <PendingMessageView
        message={{
          text: "Start cloud task",
          files: [],
          previousUserIds: [],
          starting: false,
          status: "cloud.sandboxReadySending",
          elapsedSeconds: 24,
        }}
      />,
    );
    expect(readyHtml).toContain("cloud.sandboxReadySending:24");
  });
});
