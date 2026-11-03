import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { PendingMessageView } from "./UserMessageBody.js";
import { SentAttachment } from "./MessageAttachment.js";
import type { Action } from "./services.js";

vi.mock("./i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
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
  });
});
