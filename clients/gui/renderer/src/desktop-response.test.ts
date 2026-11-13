import { describe, expect, it } from "vite-plus/test";
import { hostCommandError, readFileOpenResult, readSnapshot } from "./desktop-response.js";

describe("Host command response loss", () => {
  it.each([
    {
      name: "queueEdit",
      params: { operation: "pause", requestId: "original-queue" },
      id: "original-queue",
    },
    {
      name: "manage",
      params: { operation: "taskDraftStart", draftId: "original-draft" },
      id: "original-draft",
    },
  ])(
    "retains the original $name business identity for receipt reconciliation",
    ({ name, params, id }) => {
      expect(hostCommandError(name, params, new Error("connection closed"))).toMatchObject({
        submissionUnknown: true,
        requestId: id,
        outcome: { kind: "unconfirmed" },
        recovery: { kind: "queryOriginal" },
      });
    },
  );

  it("keeps domain response IDs distinct from recoverable mutation IDs", () => {
    expect(
      hostCommandError("respond", { requestId: "interaction" }, new Error("connection closed")),
    ).not.toHaveProperty("requestId");
  });
});

describe("desktop Host recovery snapshots", () => {
  it.each([
    { recovery: "check", phase: "admissionUnconfirmed" },
    { recovery: "reconnect", phase: "completed" },
  ])("preserves $recovery for a $phase Host stop", ({ recovery, phase }) => {
    const snapshot = {
      projects: [],
      connection: { state: "unavailable", recovery },
      lifecycle: {
        supported: false,
        kind: "stopHost",
        phase,
        operations: [{ requestId: "original-stop", kind: "stopHost", phase, targets: [] }],
      },
    };

    expect(readSnapshot(snapshot)).toMatchObject(snapshot);
  });

  it("rejects an unknown recovery action", () => {
    expect(() =>
      readSnapshot({ projects: [], connection: { state: "unavailable", recovery: "restart" } }),
    ).toThrow();
  });
});

describe("desktop file-open responses", () => {
  it("accepts PDF bytes returned for the in-app viewer", () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\n");

    const result = readFileOpenResult({ mimeType: "application/pdf", bytes });

    expect(result).toEqual({ mimeType: "application/pdf", bytes });
    expect("bytes" in result && result.bytes).toBe(bytes);
  });

  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
    "retains support for %s responses",
    (mimeType) => {
      const bytes = new Uint8Array([1, 2, 3]);

      expect(readFileOpenResult({ mimeType, bytes })).toEqual({ mimeType, bytes });
    },
  );

  it.each(["text/html", "image/svg+xml", "application/octet-stream"])(
    "rejects unsupported %s responses",
    (mimeType) => {
      expect(() => readFileOpenResult({ mimeType, bytes: new Uint8Array([1]) })).toThrow();
    },
  );

  it.each([[1, 2, 3], new ArrayBuffer(3), "JVBERi0xLjc=", undefined])(
    "rejects PDF responses without Uint8Array bytes (%s)",
    (bytes) => {
      expect(() => readFileOpenResult({ mimeType: "application/pdf", bytes })).toThrow();
    },
  );

  it.each([
    {},
    { saved: true },
    {
      targets: [{ id: "system", label: "System viewer" }],
      preferred: "system",
      preferredLabel: "System viewer",
    },
  ])("retains other file-open receipts (%j)", (receipt) => {
    expect(readFileOpenResult(receipt)).toEqual(receipt);
  });
});
