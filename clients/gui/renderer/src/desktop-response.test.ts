import { describe, expect, it } from "vite-plus/test";
import { readFileOpenResult } from "./desktop-response.js";

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
