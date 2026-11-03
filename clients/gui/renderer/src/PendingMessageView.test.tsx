import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { PendingMessageView } from "./UserMessageBody.js";

vi.mock("./i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
vi.mock("./components/ai-elements/message.js", () => ({
  MessageResponse: ({ children }: { children: string }) => <div>{children}</div>,
}));

describe("pending message attachments", () => {
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
