import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { OpenSettingsContext } from "./settings/openSettingsContext.js";
import { ComposerModelMenu, composerModelOption } from "./ComposerModelMenu.js";

vi.mock("./i18n/IntlProvider.js", () => ({
  useI18n: () => ({ t: (id: string) => id }),
}));

const menu = vi.hoisted(() => ({
  expanded: false,
  actions: new Map<string, () => void>(),
}));

vi.mock("./components/ui/popover.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./components/ui/popover.js")>();
  return {
    ...original,
    PopoverContent: (props: ComponentProps<typeof original.PopoverContent>) =>
      menu.expanded ? createElement("div", null, props.children) : null,
  };
});

vi.mock("./components/ui/tooltip.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./components/ui/tooltip.js")>();
  return {
    ...original,
    TooltipTrigger: (props: ComponentProps<typeof original.TooltipTrigger>) => props.render,
  };
});

vi.mock("./components/ui/button.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./components/ui/button.js")>();
  return {
    ...original,
    Button: (props: ComponentProps<typeof original.Button>) => {
      const label = props["aria-label"];
      if (label && props.onClick) {
        const onClick = props.onClick;
        menu.actions.set(label, () => Reflect.apply(onClick, undefined, []));
      }
      return createElement(original.Button, props);
    },
  };
});

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
    "shows only the model name for %s while keeping its configured provider name in the description",
    (provider) => {
      const markup = render(`${provider}/family/shared-model`);
      expect(markup).toContain(`aria-description="Shared model · Configured ${provider}"`);
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
    expect(markup).toContain('aria-description="custom-effort"');
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

describe("composer reasoning capabilities", () => {
  it.each([
    { name: "explicit empty options", reasoning: true, options: [], known: true, expected: [] },
    {
      name: "restricted options",
      reasoning: true,
      options: ["low", "high"],
      known: true,
      expected: ["low", "high"],
    },
    {
      name: "unknown options",
      reasoning: true,
      options: [],
      known: false,
      expected: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    },
    {
      name: "non-reasoning model",
      reasoning: false,
      options: ["high"],
      known: true,
      expected: [],
    },
  ])(
    "offers only supported choices for $name and keeps Fast independent",
    ({ reasoning, options, known, expected }) => {
      const option = composerModelOption({
        providerId: "terra",
        modelId: "model",
        reasoningEffortOptions: options,
        capabilities: {
          reasoning,
          ...(known ? { reasoningEffortOptions: options } : {}),
        },
      });
      expect(option.effortsKnown).toBe(known);
      const onEffortChange = vi.fn();
      const onServiceTierChange = vi.fn();
      menu.expanded = true;
      menu.actions.clear();
      try {
        const markup = renderToStaticMarkup(
          createElement(ComposerModelMenu, {
            options: [option],
            value: option.value,
            effort: "default",
            onEffortChange,
            onServiceTierChange,
            onChange: vi.fn(),
            onClose: vi.fn(),
          }),
        );
        const choices = [...markup.matchAll(/aria-label="chat\.composer\.effort\.([a-z]+)"/g)].map(
          (match) => match[1],
        );
        expect(choices).toEqual(expected);
        expect(markup.includes("composer-slider-shell")).toBe(expected.length > 0);
        expect(markup).toContain("chat.composer.serviceDefault");
        expect(menu.actions.has("chat.composer.enableFast")).toBe(true);
        menu.actions.get("chat.composer.enableFast")?.();
        expect(onServiceTierChange).toHaveBeenCalledWith("fast");
        expect(onEffortChange).not.toHaveBeenCalled();
        for (const choice of expected) {
          menu.actions.get(`chat.composer.effort.${choice}`)?.();
        }
        expect(onEffortChange.mock.calls).toEqual(expected.map((choice) => [choice]));
      } finally {
        menu.expanded = false;
        menu.actions.clear();
      }
    },
  );
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

describe("unavailable model guidance", () => {
  it("lists configured unavailable models and opens model settings", () => {
    const openSettings = vi.fn();
    const options = [
      composerModelOption({
        providerId: "a",
        providerName: "Provider A",
        modelId: "alpha",
        available: false,
        credentialState: "unavailable",
      }),
      composerModelOption({
        providerId: "a",
        providerName: "Provider A",
        modelId: "alpha-2",
        available: false,
        credentialState: "unavailable",
      }),
      composerModelOption({
        providerId: "b",
        providerName: "Provider B",
        modelId: "beta",
        unavailableReason: "storageLocked",
      }),
    ];
    menu.expanded = true;
    menu.actions.clear();
    try {
      const markup = renderToStaticMarkup(
        createElement(
          OpenSettingsContext.Provider,
          { value: openSettings },
          createElement(ComposerModelMenu, {
            options,
            value: "",
            onChange: vi.fn(),
            onClose: vi.fn(),
          }),
        ),
      );
      for (const text of [
        "alpha",
        "Provider A",
        "缺少 API Key",
        "beta",
        "Provider B",
        "钥匙串访问受限，请重新保存密钥",
      ])
        expect(markup).toContain(text);
      expect(markup).toContain("alpha-2");
      expect(markup.match(/缺少 API Key/g)).toHaveLength(1);
      expect(markup).not.toContain('type="radio"');
      menu.actions.get("chat.composer.configureModels")?.();
      expect(openSettings).toHaveBeenCalledWith("模型服务");
    } finally {
      menu.expanded = false;
      menu.actions.clear();
    }
  });

  it("keeps the empty catalog fallback", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerModelMenu, {
        options: [],
        value: "",
        onChange: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(markup).toContain("chat.composer.noModels");
  });
});
