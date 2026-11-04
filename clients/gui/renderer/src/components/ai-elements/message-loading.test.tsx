import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { MessageResponse } from "./message.js";

vi.mock("../../i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
vi.mock("./message-response-renderer.js", () => new Promise(() => {}));

describe("message rendering before Markdown is ready", () => {
  it("keeps submitted text and line breaks visible without loading-placeholder padding", () => {
    const html = renderToStaticMarkup(
      <MessageResponse className="conversation-markdown user-message-body" preserveLineBreaks>
        {"First line\nSecond line <script>not markup</script>"}
      </MessageResponse>,
    );
    expect(html).toContain("First line\nSecond line &lt;script&gt;not markup&lt;/script&gt;");
    expect(html).toContain('class="conversation-markdown user-message-body"');
    expect(html).not.toContain("common.loading");
    expect(html).not.toContain("p-3");
  });
});
