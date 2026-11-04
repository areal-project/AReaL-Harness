import { afterAll, describe, expect, test } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const oxlint = join(
  dirname(createRequire(require.resolve("vite-plus/package.json")).resolve("oxlint/package.json")),
  "bin/oxlint",
);
const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "areal-oxlint-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function lint(rule: string, source: string, filename = "fixture.tsx") {
  const config = join(scratch, ".oxlintrc.json");
  writeFileSync(
    config,
    JSON.stringify({
      jsPlugins: [{ name: "areal", specifier: resolve(root, "oxlint-plugin-areal/index.ts") }],
      categories: { correctness: "off" },
      rules: { [`areal/${rule}`]: "error" },
    }),
  );
  const file = join(scratch, filename);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  const result = spawnSync(process.execPath, [oxlint, "--config", config, file], {
    encoding: "utf8",
    cwd: root,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("require-suppression-reason", () => {
  test.each([
    "// oxlint-disable-next-line no-console -- reports to the terminal\nconsole.log(1)",
    "// reason for invalid fixture\n// @ts-expect-error\nconst x: number = 'text'",
    "// @ts-ignore: external declaration is incomplete\nexternal()",
    "/* eslint-disable no-console -- command output */",
    "/* oxlint-enable no-console */",
    "// reason\n// @ts-expect-error\n// oxlint-disable-next-line no-console\nconsole.log(1)",
  ])("accepts explained suppression: %s", (source) => {
    expect(lint("require-suppression-reason", source).status).toBe(0);
  });
  test.each([
    "/* oxlint-disable no-console */",
    "/* eslint-disable no-console */",
    "// @ts-expect-error\nconst x: number = 'text'",
    "// @ts-ignore\nexternal()",
    "// reason separated by blank line\n\n// @ts-ignore\nexternal()",
    "//\n/* */\n// @ts-ignore\nexternal()",
  ])("rejects unexplained suppression: %s", (source) => {
    const result = lint("require-suppression-reason", source);
    expect(result.status).toBe(1);
    expect(result.output).toContain("areal(require-suppression-reason)");
  });
});

describe("no-raw-resize-observer", () => {
  test.each([
    "new ResizeObserver(() => {})",
    "new window.ResizeObserver(() => {})",
    "new globalThis['ResizeObserver'](() => {})",
    "new self.ResizeObserver(() => {})",
  ])("rejects %s", (source) => {
    const result = lint("no-raw-resize-observer", source);
    expect(result.status).toBe(1);
    expect(result.output).toContain("areal(no-raw-resize-observer)");
    expect(result.output).toContain("@areal/ui/observe-resize");
  });
  test.each(["observeResize(element, callback)", "new MutationObserver(() => {})"])(
    "accepts %s",
    (source) => {
      expect(lint("no-raw-resize-observer", source).status).toBe(0);
    },
  );
});

describe("no-raw-disclosure", () => {
  test.each([
    "const a = <details><summary>Runs</summary></details>;",
    "const a = <summary>Runs</summary>;",
    'import { Collapsible } from "@base-ui/react/collapsible";',
  ])("rejects %s", (source) => {
    const result = lint("no-raw-disclosure", source);
    expect(result.status).toBe(1);
    expect(result.output).toContain("areal(no-raw-disclosure)");
    expect(result.output).toContain("R-CHECK-019");
  });
  test.each([
    'const a = <SettingsDisclosure title="Advanced">x</SettingsDisclosure>;',
    'const a = <Disclosure label="Worked">x</Disclosure>;',
    'import { Disclosure } from "@areal/ui";',
  ])("accepts %s", (source) => {
    expect(lint("no-raw-disclosure", source).status).toBe(0);
  });
});

describe("no-native-title", () => {
  test.each([
    'const a = <span title="Path">x</span>;',
    "const a = <button title={label}>x</button>;",
    'const a = <svg><g title="x" /></svg>;',
  ])("rejects %s", (source) => {
    const result = lint("no-native-title", source);
    expect(result.status).toBe(1);
    expect(result.output).toContain("R-CHECK-021");
  });
  test.each([
    'const a = <TitleTooltip title="Path"><span>x</span></TitleTooltip>;',
    'const a = <Button title="Stop">x</Button>;',
    'const a = <iframe title="Preview" src="a.html" />;',
    "const a = <svg><title>Logo</title></svg>;",
  ])("accepts %s", (source) => {
    expect(lint("no-native-title", source).status).toBe(0);
  });
});

describe("no-transition-all", () => {
  test.each([
    'const a = <div className="font-medium transition-all" />;',
    'const a = cn("transition-all duration-150", b);',
    "const a = `hover:bg-muted transition-all ${b}`;",
    'const a = "motion-safe:transition-all";',
  ])("rejects %s", (source) => {
    const result = lint("no-transition-all", source);
    expect(result.status).toBe(1);
    expect(result.output).toContain("R-CHECK-021");
  });
  test.each([
    'const a = <div className="transition-colors" />;',
    'const a = "transition-[color,background-color]";',
    "// transition-all would animate layout\nconst a = 1;",
  ])("accepts %s", (source) => {
    expect(lint("no-transition-all", source).status).toBe(0);
  });
});

describe("no-renderer-desktop-bridge", () => {
  const rendererFile = "clients/gui/renderer/src/Feature.tsx";
  test.each([
    'import type { DesktopBridge } from "@areal/workbench/desktop-contract";',
    'import { validateCommand } from "@areal/workbench/desktop-contract";',
    'import { readSnapShot } from "@areal/workbench/desktop-contract/snapshots";',
    'export type { PreviewRequest } from "@areal/workbench/desktop-contract";',
    'export * from "@areal/workbench/desktop-contract/conversation";',
    'const contract = import("@areal/workbench/desktop-contract");',
    'type Request = import("@areal/workbench/desktop-contract/conversation").Request;',
    'import contract = require("@areal/workbench/desktop-contract");',
    'const contract = require("../../packages/workbench/client/desktop-contract.cjs");',
    'import type { Request } from "../../packages/workbench/client/desktop-contract.js";',
    'import { ProjectionReader } from "@areal/workbench/state-projection";',
    'export * from "@areal/workbench/state-projection";',
    'const projection = import("@areal/workbench/state-projection");',
    'const projection = require("../../packages/workbench/client/state-projection.cjs");',
    'arealDesktop.command("stop");',
    "const bridge = arealDesktop;",
    "const bridge = { arealDesktop };",
    "arealHost.connect();",
    "typeof arealDesktop;",
    'window.arealDesktop.command("stop");',
    'window["arealDesktop"].command("stop");',
    'window[`arealDesktop`].command("stop");',
    "(window as unknown as { arealDesktop: unknown }).arealDesktop;",
    "globalThis.window.arealDesktop;",
    'globalThis["arealDesktop"];',
    "const { arealDesktop: bridge } = window;",
    'const { ["arealDesktop"]: bridge } = window;',
    "const nativeWindow = window; nativeWindow.arealDesktop;",
    "const { window: nativeWindow } = globalThis; nativeWindow.arealDesktop;",
    'let nativeWindow; nativeWindow = window; nativeWindow["arealDesktop"];',
    "const nativeWindow = window; const { arealDesktop: bridge } = nativeWindow;",
    "window.arealHost;",
    'window["arealHost"];',
    'const key = "arealDesktop"; window[key];',
    'const key = "arealDesktop"; const { [key]: bridge } = window;',
    'const contractPath = "@areal/workbench/desktop-contract"; import(contractPath);',
    "window?.arealDesktop;",
    "(globalThis.window!).arealDesktop;",
  ])("rejects renderer boundary violation: %s", (source) => {
    const result = lint("no-renderer-desktop-bridge", source, rendererFile);
    expect(result.status).toBe(1);
    expect(result.output).toContain("areal(no-renderer-desktop-bridge)");
    expect(result.output).toContain("PlatformServices from services.ts");
    expect(result.output).not.toContain("A0:");
  });
  test.each([
    'import type { PlatformServices } from "./services.js";',
    'import { modelUsage } from "./services.js";',
    'window.addEventListener("pagehide", close);',
    'const settings = { arealDesktop: "label" }; settings.arealDesktop;',
    "const { arealDesktop } = settings;",
    "const arealDesktop = { command() {} }; arealDesktop.command();",
    "function f(arealHost: { connect(): void }) { arealHost.connect(); }",
    "type Settings = { arealDesktop: string };",
    "function f(window: { arealDesktop: string }) { return window.arealDesktop; }",
    "const nativeWindow = window; function f(nativeWindow: { arealDesktop: string }) { return nativeWindow.arealDesktop; }",

    "// window.arealDesktop is owned by the platform adapter",
  ])("accepts renderer code: %s", (source) => {
    expect(lint("no-renderer-desktop-bridge", source, rendererFile).status).toBe(0);
  });
  test.each([
    "clients/gui/renderer/src/desktop-services.ts",
    "clients/gui/app/src/core/preload.cjs",
    "clients/gui/packages/workbench/client/desktop-contract.js",
  ])("accepts platform boundary or non-renderer file: %s", (filename) => {
    const result = lint(
      "no-renderer-desktop-bridge",
      'const contract = require("@areal/workbench/desktop-contract"); window.arealDesktop;',
      filename,
    );
    expect(result.status).toBe(0);
  });
  test("allows decoding contracts but not preload access in desktop-response.ts", () => {
    const filename = "clients/gui/renderer/src/desktop-response.ts";
    expect(
      lint(
        "no-renderer-desktop-bridge",
        'import { desktopError } from "@areal/workbench/desktop-contract/transport";',
        filename,
      ).status,
    ).toBe(0);
    expect(lint("no-renderer-desktop-bridge", "window.arealDesktop;", filename).status).toBe(1);
  });
  test.each([
    "clients/gui/renderer/src/settings/desktop-services.ts",
    "clients/gui/renderer/src/desktop-services.tsx",
    "clients/gui/renderer/src/desktop-services-helper.ts",
    "clients/gui/renderer/src/services.ts",
  ])("does not allow a lookalike adapter path: %s", (filename) => {
    const result = lint("no-renderer-desktop-bridge", "window.arealDesktop;", filename);
    expect(result.status).toBe(1);
    expect(result.output).toContain("areal(no-renderer-desktop-bridge)");
  });
  test.each([
    "clients/gui/renderer/remote-web/feature.mjs",
    "clients/gui/packages/ui/src/Feature.tsx",
    "clients/gui/packages/remote/src/feature.mjs",
    "clients/gui/packages/remote-client/src/feature.mjs",
    "clients/gui/packages/app/src/Feature.tsx",
    "clients/gui/packages/client/src/feature.ts",
    "clients/gui/packages/ui/src/desktop-services.ts",
  ])("guards shared interface code: %s", (filename) => {
    for (const source of [
      "window.arealDesktop;",
      "arealHost.connect();",
      'import { validateCommand } from "@areal/workbench/desktop-contract";',
      'import { ProjectionReader } from "@areal/workbench/state-projection";',
    ]) {
      const result = lint("no-renderer-desktop-bridge", source, filename);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain("areal(no-renderer-desktop-bridge)");
    }
  });
  test.each([
    "clients/gui/renderer/src/Feature.test.tsx",
    "clients/gui/renderer/src/Feature.spec.ts",
    "clients/gui/packages/ui/src/Feature.test.tsx",
    "clients/gui/packages/remote/src/feature.test.mjs",
  ])("allows bridge mocks in test files: %s", (filename) => {
    expect(
      lint(
        "no-renderer-desktop-bridge",
        "window.arealDesktop = {}; window.arealHost = {};",
        filename,
      ).status,
    ).toBe(0);
  });
  test("a production helper does not inherit the test-file exception", () => {
    const result = lint(
      "no-renderer-desktop-bridge",
      "window.arealDesktop;",
      "clients/gui/renderer/src/bridge.test-helper.ts",
    );
    expect(result.status).toBe(1);
  });
});
