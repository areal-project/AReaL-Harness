import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ComposerModelMenu, composerModelOption } from "./ComposerModelMenu.js";

vi.mock("./i18n/IntlProvider.js", () => ({
  useI18n: () => ({ t: (id: string) => id }),
}));

const catalog = ["direct", "relay"].map((providerId) => ({
  providerId,
  providerName: `Configured ${providerId}`,
  modelId: "family/shared-model",
  displayName: "Shared model",
  capabilities: { reasoning: false },
}));

function render(value: string) {
  return renderToStaticMarkup(
    createElement(ComposerModelMenu, {
      options: catalog.map(composerModelOption),
      value,
      onChange: vi.fn(),
      onClose: vi.fn(),
    }),
  );
}

describe("composer model provider identity", () => {
  it("preserves distinct providers and model IDs containing slashes without mutating the catalog", () => {
    const original = structuredClone(catalog);
    const options = catalog.map(composerModelOption);
    expect(options.map((option) => option.value)).toEqual([
      "direct/family/shared-model",
      "relay/family/shared-model",
    ]);
    expect(options.map((option) => option.providerId)).toEqual(["direct", "relay"]);
    expect(catalog).toEqual(original);
  });

  it.each(["direct", "relay"])(
    "shows only the model name for %s while keeping its configured provider name in the title",
    (provider) => {
      const markup = render(`${provider}/family/shared-model`);
      expect(markup).toContain(`title="Shared model · Configured ${provider}"`);
      expect(markup.replace(/<[^>]*>/g, "")).toBe("Shared model");
    },
  );

  it("shows an independent effort trigger for a non-reasoning model and preserves custom values", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerModelMenu, {
        options: catalog.map(composerModelOption),
        value: "direct/family/shared-model",
        effort: "custom-effort",
        onEffortChange: vi.fn(),
        onChange: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(markup).toContain('aria-label="chat.composer.chooseModel"');
    expect(markup).toContain('aria-label="chat.composer.chooseEffort"');
    expect(markup).toContain('title="custom-effort"');
  });

  it("does not invent a provider for an implicit legacy default", () => {
    const option = composerModelOption({ modelId: "legacy" });
    expect(option.value).toBe("");
    expect(option.providerId).toBeUndefined();
    const markup = renderToStaticMarkup(
      createElement(ComposerModelMenu, {
        options: [option],
        value: "",
        onChange: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(markup).not.toContain('class="composer-model-provider"');
  });
});

describe("composer confirmed Fast status", () => {
  it.each([undefined, "default", "fast"])("shows requested Fast only for %s", (serviceTier) => {
    const markup = renderToStaticMarkup(
      createElement(ComposerModelMenu, {
        options: catalog.map(composerModelOption),
        value: "direct/family/shared-model",
        effort: "max",
        serviceTier,
        onServiceTierChange: vi.fn(),
        onEffortChange: vi.fn(),
        onChange: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(markup.includes("Fast · chat.composer.effort.max")).toBe(serviceTier === "fast");
    expect(markup).toContain('aria-label="chat.composer.chooseEffort"');
  });
});
