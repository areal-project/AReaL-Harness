import { Children, createElement, isValidElement, type ReactNode } from "react";
import { Popover, PopoverContent } from "@areal/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FeedbackNotice } from "./FeedbackNotice.js";
import type { ToastMessage } from "./components/ui/toast.js";

const observed = vi.hoisted(() => {
  vi.stubGlobal("document", new EventTarget());
  return { effects: [] as (() => void)[], notices: [] as ToastMessage[] };
});
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void) => {
    observed.effects.push(effect);
  },
}));
vi.mock("./i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
document.addEventListener("areal:toast", (event) => {
  observed.notices.push((event as CustomEvent<ToastMessage>).detail);
});

function render(attempt: number) {
  const markup = renderToStaticMarkup(
    createElement(FeedbackNotice, {
      id: `upload-attempt-${attempt}`,
      tone: "error",
      message: "document.txt: Upload failed",
      detail: "Error invoking remote method: fixture denied",
      actions: createElement("button", {}, "Check original"),
    }),
  );
  for (const effect of observed.effects.splice(0)) effect();
  return markup;
}

beforeEach(() => {
  observed.effects = [];
  observed.notices = [];
});
describe("transient feedback details", () => {
  it("emits one top notification and opens technical detail separately from its summary", () => {
    expect(render(1)).toBe("");
    expect(observed.notices).toHaveLength(1);
    const notice = observed.notices[0];
    expect(notice.message).toBe("document.txt: Upload failed");
    const actions = renderToStaticMarkup(createElement("div", {}, notice.actions));
    expect(actions).toContain("Check original");
    expect(actions).toContain("recovery.details");
    expect(actions).toContain('aria-haspopup="dialog"');
    expect(actions).not.toContain("fixture denied");
    if (!isValidElement<{ children: ReactNode }>(notice.actions))
      throw new Error("Missing actions");
    const popover = Children.toArray(notice.actions.props.children).find(
      (child) => isValidElement(child) && child.type === Popover,
    );
    if (!isValidElement<{ children: ReactNode }>(popover))
      throw new Error("Missing detail popover");
    const content = Children.toArray(popover.props.children).find(
      (child) => isValidElement(child) && child.type === PopoverContent,
    );
    if (!isValidElement<{ children: ReactNode }>(content))
      throw new Error("Missing detail content");
    const detail = renderToStaticMarkup(createElement(Popover, {}, content.props.children));
    expect(detail).toContain("fixture denied");
  });

  it("gives an identical failure on a new retry a new notification identity", () => {
    render(1);
    render(2);
    expect(observed.notices).toHaveLength(2);
    expect(observed.notices[0].message).toBe(observed.notices[1].message);
    expect(observed.notices[0].key).not.toBe(observed.notices[1].key);
  });
});
