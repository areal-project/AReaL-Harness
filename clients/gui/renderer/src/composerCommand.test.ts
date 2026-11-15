import { describe, expect, it } from "vite-plus/test";
import {
  commandForSubmission,
  conversationQuotes,
  type ComposerCommand,
} from "./composerCommand.js";

describe("composer command adapter", () => {
  it("keeps steer identity separate from ordinary send", () => {
    const command: ComposerCommand = { kind: "steer", threadId: "thread", expectedTurnId: "turn" };
    expect(commandForSubmission(command, { text: "adjust" })).toEqual({
      action: "steer",
      params: { text: "adjust", threadId: "thread", expectedTurnId: "turn" },
    });
  });

  it("encodes typed conversation quotes through the existing wire field", () => {
    expect(
      conversationQuotes([
        { kind: "conversationQuote", text: "quoted", sourceRowId: "row" },
        { kind: "conversationQuote", text: "  " },
      ]),
    ).toEqual([{ text: "quoted" }]);
  });
});
