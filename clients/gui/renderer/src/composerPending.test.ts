import { describe, expect, test } from "vite-plus/test";
import { composerPending } from "./composerPending.js";

const configure = {
  method: "areal/thread/configure",
  params: { threadId: "chat", requestId: "save" },
  awaitingResponse: true,
};

describe("Composer configuration admission", () => {
  test("editing stays available across receipt and pending projection ordering", () => {
    for (const [entries, requestId] of [
      [[], "save"],
      [[configure], "save"],
      [[configure], null],
    ] as const)
      expect(composerPending([...entries], "chat", requestId)).toEqual({
        configuring: true,
        pending: false,
      });
    expect(composerPending([], "chat", null)).toEqual({ configuring: false, pending: false });
  });

  test("unknown configuration and other outstanding mutations retain their barrier", () => {
    for (const entry of [
      { ...configure, awaitingResponse: false },
      { method: configure.method, params: configure.params },
      { ...configure, method: "turn/start" },
    ])
      expect(composerPending([entry], "chat", null)).toEqual({
        configuring: false,
        pending: true,
      });
    expect(
      composerPending(
        [configure, { method: "turn/start", params: { threadId: "chat", requestId: "send" } }],
        "chat",
        "save",
      ),
    ).toEqual({ configuring: true, pending: true });
  });

  test("another chat's configuration cannot lock this chat", () => {
    expect(composerPending([configure], "other", null)).toEqual({
      configuring: false,
      pending: false,
    });
  });
});
