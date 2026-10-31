import { describe, expect, it, vi } from "vite-plus/test";
import {
  filterComposerModels,
  readFavoriteModels,
  saveFavoriteModels,
} from "./composerModelPreferences.js";
const options = [
  {
    value: "direct/shared/model",
    label: "Shared model",
    providerId: "direct",
    providerName: "Direct API",
  },
  {
    value: "relay/shared/model",
    label: "Shared model",
    providerId: "relay",
    providerName: "Relay",
  },
];
describe("model discovery preferences", () => {
  it("searches model and provider names together while preserving model identity", () => {
    expect(filterComposerModels(options, "SHARED relay")).toEqual([options[1]]);
    expect(filterComposerModels(options, "shared/model")).toEqual(options);
    expect(filterComposerModels(options, "unknown")).toEqual([]);
  });
  it("restores favorites by full provider/model identity after reload", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    saveFavoriteModels([options[1].value]);
    expect(filterComposerModels(options, "", readFavoriteModels())).toEqual([options[1]]);
    saveFavoriteModels([]);
    expect(readFavoriteModels()).toEqual([]);
    vi.unstubAllGlobals();
  });
  it("reports storage failures instead of claiming favorites were saved", () => {
    vi.stubGlobal("localStorage", {
      setItem() {
        throw new Error("Quota exceeded");
      },
    });
    expect(() => saveFavoriteModels([options[0].value])).toThrow("Quota exceeded");
    vi.unstubAllGlobals();
  });
});
