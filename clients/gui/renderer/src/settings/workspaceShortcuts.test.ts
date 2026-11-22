import { describe, expect, it } from "vite-plus/test";
import { matchesWorkspaceShortcut } from "./workspaceShortcuts.js";

describe("matchesWorkspaceShortcut", () => {
  it("matches Mac ⌘ combos with either metaKey or ctrlKey", () => {
    const macEvent = {
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      key: "s",
    } as KeyboardEvent;
    const winEvent = {
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      key: "S",
    } as KeyboardEvent;
    expect(matchesWorkspaceShortcut(macEvent, "⌘+⇧+S")).toBe(true);
    expect(matchesWorkspaceShortcut(winEvent, "⌘+⇧+S")).toBe(true);
    expect(matchesWorkspaceShortcut(macEvent, "⌘+F")).toBe(false);
    expect(matchesWorkspaceShortcut(macEvent, "")).toBe(false);
  });
});
