import { describe, expect, it } from "vite-plus/test";
import { readPreviewResult } from "./desktop-response.js";
import { previewFailure } from "./browserPreview.js";

describe("browser operation failures", () => {
  it("uses an explicit permission rejection instead of inferring it from page text", () => {
    expect(
      previewFailure(Object.assign(new Error("denied"), { code: "BROWSER_PERMISSION_DENIED" })),
    ).toEqual({ kind: "permission", message: "操作没有完成，请重试。" });
    expect(previewFailure(new Error("permission denied by page"))).toEqual({
      kind: "operation",
      message: "操作没有完成，请重试。",
    });
  });
  it("retains an unknown action outcome for inspection", () => {
    expect(previewFailure(new Error("outcome_unknown")).kind).toBe("unknown");
    expect(previewFailure(new Error("network disconnected")).kind).toBe("operation");
  });
});

describe("desktop preview failure transport", () => {
  it("preserves rejection codes across a serialized IPC result without turning load state into rejection", () => {
    const result = JSON.parse(
      JSON.stringify({ previewFailure: { message: "denied", code: "BROWSER_PERMISSION_DENIED" } }),
    );
    try {
      readPreviewResult(result);
      expect.fail("expected permission rejection");
    } catch (error) {
      expect(previewFailure(error)).toEqual({
        kind: "permission",
        message: "操作没有完成，请重试。",
      });
    }
    expect(
      readPreviewResult({ error: "ERR_CONNECTION_REFUSED", url: "http://localhost:1234" }),
    ).toEqual({ error: "ERR_CONNECTION_REFUSED", url: "http://localhost:1234" });
  });
  it("rejects malformed failure receipts and retains unknown outcomes", () => {
    expect(() =>
      readPreviewResult({ previewFailure: { code: "BROWSER_PERMISSION_DENIED" } }),
    ).toThrow("Invalid Desktop preview failure");
    expect(() => readPreviewResult({ previewFailure: { message: "outcome_unknown" } })).toThrow(
      "outcome_unknown",
    );
  });
});
