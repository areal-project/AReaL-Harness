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

  it("carries one structured context part through main, side, and remote submissions", () => {
    const contextParts = [
      {
        type: "reviewComment" as const,
        comment: {
          id: "comment",
          path: "src/app.ts",
          root: "/workspace",
          scope: "branch",
          ref: "main",
          token: "token",
          head: "head",
          base: "base",
          side: "additions" as const,
          start: 3,
          end: 3,
          snippet: "const value = 1;",
          body: "Please extract this value.",
        },
      },
    ];
    const base = { text: "please fix", contextParts };
    expect(
      commandForSubmission({ kind: "send", threadId: "main", enqueue: false }, base).params,
    ).toMatchObject(base);
    expect(
      commandForSubmission({ kind: "sideSend", threadId: "side", sourceThreadId: "main" }, base)
        .params,
    ).toMatchObject(base);
    // Remote uses the same Host send command and therefore the same payload shape.
    expect(
      commandForSubmission({ kind: "send", threadId: "remote", enqueue: true }, base).params,
    ).toMatchObject(base);
  });
});
