import { describe, expect, it, vi } from "vite-plus/test";
import { wireParameters } from "./SessionSettings.js";

vi.mock("../i18n/IntlProvider.js", () => ({
  useI18n: () => ({ t: (id: string) => id }),
  UiMessageError: Error,
}));

describe("session settings parameter submission", () => {
  it.each(["fast", "default"])(
    "preserves explicit %s when saving other settings",
    (serviceTier) => {
      expect(
        wireParameters({ serviceTier, reasoningEffort: "max", temperature: 0.4 }, false),
      ).toEqual({ serviceTier, reasoningEffort: "max", temperature: 0.4, maxOutputTokens: null });
    },
  );

  it("keeps inheritance when no tier was selected", () => {
    expect(wireParameters({ reasoningEffort: "high" }, false)).not.toHaveProperty("serviceTier");
  });

  it("clears the tier together with other parameters on explicit reset", () => {
    expect(wireParameters({ serviceTier: "fast", reasoningEffort: "max" }, true)).toEqual({});
  });
});
