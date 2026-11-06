import { describe, expect, it } from "vite-plus/test";
import { composerTriggerBeforeCaret } from "./slashCommandHelpers.js";

describe("composerTriggerBeforeCaret", () => {
  it.each([
    ["@", "@", ""],
    ["看看 @src/Ma", "@", "src/ma"],
    ["/", "/", ""],
    ["先 /side", "/", "side"],
    ["$", "$", ""],
    ["用 $review", "$", "review"],
  ])("reads %s", (text, trigger, query) => {
    expect(composerTriggerBeforeCaret(text)).toMatchObject({ trigger, query });
  });

  it.each(["花了 $5", "a@b.com", "src/math.ts", "price$"])("ignores %s", (text) => {
    expect(composerTriggerBeforeCaret(text)).toBeNull();
  });
});
