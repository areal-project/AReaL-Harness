import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ComposerAttachment } from "./ComposerAttachments.js";
import {
  composerUploads,
  forgetComposerUploads,
  setComposerUploadState,
} from "./ComposerUploadState.js";
import type { Button } from "@areal/ui";

const observed = vi.hoisted(() => ({ buttons: [] as ComponentProps<typeof Button>[] }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("@areal/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@areal/ui")>()),
  Button: (props: ComponentProps<typeof Button>) => {
    observed.buttons.push(props);
    return createElement(
      "button",
      { disabled: props.disabled, onClick: props.onClick },
      props.children,
    );
  },
}));
vi.mock("./i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
vi.mock("./imageAnnotations.js", () => ({
  useImageAnnotationRevision: () => {},
  imageAnnotation: () => undefined,
}));

const file = new File(["content"], "document.txt", { type: "text/plain" });
function render(owner: string) {
  const onRetry = vi.fn().mockResolvedValue(undefined);
  const markup = renderToStaticMarkup(
    createElement(ComposerAttachment, {
      file,
      uploadOwner: owner,
      onRetry,
      onRemove: vi.fn(),
      onExpand: vi.fn(),
    }),
  );
  return { markup, onRetry };
}

beforeEach(() => {
  observed.buttons = [];
});
describe("compact composer attachment feedback", () => {
  it.each(["pending", "reading", "uploading", "ready"] as const)(
    "keeps %s upload state out of the attachment copy",
    (state) => {
      const owner = crypto.randomUUID();
      setComposerUploadState(
        owner,
        file,
        state === "ready"
          ? { state, receipt: { type: "file", url: "core-media:receipt", name: file.name } }
          : { state },
      );
      const { markup } = render(owner);
      expect(markup).toContain("document.txt");
      expect(markup).not.toMatch(/role="(?:alert|status)"/);
      expect(markup).not.toContain("chat.composer.attachment");
      expect(markup).not.toContain("chat.composer.retryAttachment");
      forgetComposerUploads(owner, [file]);
    },
  );

  it("keeps a failed file retryable without duplicating its parent notification", async () => {
    const owner = crypto.randomUUID();
    setComposerUploadState(owner, file, { state: "failed", message: "fixture denied" });
    const { markup, onRetry } = render(owner);
    expect(markup).toContain("chat.composer.retryAttachment");
    expect(markup).toContain("移除附件 document.txt");
    expect(markup).not.toContain("fixture denied");
    expect(markup).not.toMatch(/role="(?:alert|status)"/);
    const retry = observed.buttons.find(
      (props) => props.children === "chat.composer.retryAttachment",
    )!;
    retry.onClick!({} as Parameters<NonNullable<typeof retry.onClick>>[0]);
    await vi.waitFor(() => expect(onRetry).toHaveBeenCalledWith(file));
    forgetComposerUploads(owner, [file]);
  });

  it("keeps an unknown receipt intact and offers only removal on its tile", () => {
    const owner = crypto.randomUUID();
    const error = new Error("accepted response lost");
    setComposerUploadState(owner, file, { state: "unknown", message: error.message, error });
    const { markup, onRetry } = render(owner);
    expect(markup).not.toContain("chat.composer.retryAttachment");
    expect(markup).not.toContain(error.message);
    expect(markup).not.toMatch(/role="(?:alert|status)"/);
    expect(markup).toContain("移除附件 document.txt");
    expect(composerUploads(owner).states.get(file)).toMatchObject({ state: "unknown", error });
    expect(onRetry).not.toHaveBeenCalled();
    forgetComposerUploads(owner, [file]);
  });
});
