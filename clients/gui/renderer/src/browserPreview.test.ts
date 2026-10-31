import { describe, expect, it } from "vite-plus/test";
import { previewFailure } from "./browserPreview.js";

describe("browser operation failures", () => {
  it("uses an explicit permission rejection instead of inferring it from page text", () => {
    expect(
      previewFailure(Object.assign(new Error("denied"), { code: "BROWSER_PERMISSION_DENIED" })),
    ).toEqual({ kind: "permission", message: "denied" });
    expect(previewFailure(new Error("permission denied by page"))).toEqual({
      kind: "operation",
      message: "permission denied by page",
    });
  });
  it("retains an unknown action outcome for inspection", () => {
    expect(previewFailure(new Error("outcome_unknown")).kind).toBe("unknown");
    expect(previewFailure(new Error("network disconnected")).kind).toBe("operation");
  });
});
