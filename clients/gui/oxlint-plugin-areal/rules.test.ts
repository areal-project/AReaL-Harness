import { afterAll, describe, expect, test } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
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

describe("no-smoke-transport-patch", () => {
  test.each([
    "ServiceConnection.prototype.request = async function () {};",
    "WebSocket.prototype.send = function () {};",
    'WebSocket["prototype"]["send"] = original;',
    'Object.defineProperty(WebSocket.prototype, "send", { value: replacement });',
    'const { ServiceConnection } = process.mainModule.require("./core/service-client.cjs");',
    "delete ServiceConnection.prototype.request;",
  ])("rejects transport patch: %s", (source) => {
    const result = lint("no-smoke-transport-patch", source, "fixture.mjs");
    expect(result.status).toBe(1);
    expect(result.output).toContain("areal(no-smoke-transport-patch)");
  });
  test.each([
    "const original = WebSocket.prototype.send;",
    "new ServiceConnection();",
    "fixture.send = replacement;",
    "globalThis.createHostTransportBarrier(match);",
  ])("allows normal use: %s", (source) => {
    expect(lint("no-smoke-transport-patch", source, "fixture.mjs").status).toBe(0);
  });
  test("the project lint configuration guards the migrated scripts", () => {
    const project = join(scratch, "smoke-config");
    mkdirSync(join(project, "scripts"), { recursive: true });
    writeFileSync(
      join(project, "package.json"),
      '{"name":"smoke-lint-fixture","private":true,"type":"module"}',
    );
    copyFileSync(join(root, "vite.config.mts"), join(project, "vite.config.mts"));
    symlinkSync(join(root, "node_modules"), join(project, "node_modules"));
    symlinkSync(join(root, "oxlint-plugin-areal"), join(project, "oxlint-plugin-areal"));
    const files = [
      "composer-files-acceptance.mjs",
      "model-selection-smoke.mjs",
      "conversation-derivation-smoke.mjs",
    ];
    for (const file of files)
      writeFileSync(join(project, "scripts", file), "WebSocket.prototype.send = replacement;\n");
    const vp = join(root, "node_modules/vite-plus/bin/vp");
    const result = spawnSync(
      process.execPath,
      [vp, "lint", ...files.map((file) => `scripts/${file}`)],
      { cwd: project, encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    for (const file of files) expect(result.stdout + result.stderr).toContain(file);
    expect(result.stdout + result.stderr).toContain("no-smoke-transport-patch");
    const asyncFile = join(project, "scripts", "async-predicate.mjs");
    writeFileSync(asyncFile, "page.waitForFunction(async () => false);\n");
    const asyncResult = spawnSync(process.execPath, [vp, "lint", "scripts/async-predicate.mjs"], {
      cwd: project,
      encoding: "utf8",
    });
    expect(asyncResult.status, asyncResult.stdout + asyncResult.stderr).toBe(1);
    expect(asyncResult.stdout + asyncResult.stderr).toContain("no-async-wait-for-function");
  });
});

describe("no-async-wait-for-function", () => {
  test.each([
    "page.waitForFunction(async () => false);",
    "page['waitForFunction'](async function () { return false; });",
  ])("rejects async polling predicate: %s", (source) => {
    const result = lint("no-async-wait-for-function", source, "fixture.mjs");
    expect(result.status).toBe(1);
    expect(result.output).toContain("areal(no-async-wait-for-function)");
  });
  test.each([
    "page.waitForFunction(() => document.readyState === 'complete');",
    "page.evaluate(async () => false);",
    "const text = 'page.waitForFunction(async () => false)';",
  ])("allows other expressions: %s", (source) => {
    expect(lint("no-async-wait-for-function", source, "fixture.mjs").status).toBe(0);
  });
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
  test.each([
    {
      filename: "clients/gui/renderer/src/desktop-response.ts",
      source: 'import { desktopError } from "@areal/workbench/desktop-contract/transport";',
    },
    {
      filename: "clients/gui/renderer/src/host-services.ts",
      source:
        'import { readObservationResult } from "@areal/workbench/desktop-contract/conversation-history";',
    },
  ])("allows decoding contracts but not preload access in $filename", ({ filename, source }) => {
    expect(lint("no-renderer-desktop-bridge", source, filename).status).toBe(0);
    for (const preload of ["window.arealDesktop;", "window.arealHost;"]) {
      const result = lint("no-renderer-desktop-bridge", preload, filename);
      expect(result.status).toBe(1);
      expect(result.output).toContain("areal(no-renderer-desktop-bridge)");
    }
  });
  test.each([
    "clients/gui/renderer/src/settings/host-services.ts",
    "clients/gui/renderer/src/host-services.tsx",
    "clients/gui/renderer/src/host-services-helper.ts",
  ])("rejects contract decoding in a lookalike Host adapter: %s", (filename) => {
    const result = lint(
      "no-renderer-desktop-bridge",
      'import { readObservationResult } from "@areal/workbench/desktop-contract/conversation-history";',
      filename,
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain("areal(no-renderer-desktop-bridge)");
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
  test.each([
    "window.arealDesktop;",
    'import type { DesktopBridge } from "@areal/workbench/desktop-contract";',
    'import { ProjectionReader } from "@areal/workbench/state-projection";',
    "window.arealDesktop ||= {};",
  ])("rejects boundary violations in test files: %s", (source) => {
    const result = lint(
      "no-renderer-desktop-bridge",
      source,
      "clients/gui/renderer/src/Feature.test.tsx",
    );
    expect(result.status, result.output).toBe(1);
  });
  test("rejects bridge writes in production", () => {
    expect(
      lint("no-renderer-desktop-bridge", "window.arealDesktop = {};", rendererFile).status,
    ).toBe(1);
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

describe("no-workbench-core-owner", () => {
  const filename = "services/workbench/src/desktop/core/new-module.ts";
  test.each([
    'import { CoreClient as Renamed } from "@areal/runtime-client/core";',
    'const client = import("@areal/runtime-client/core");',
    'const core = require("./core-process.cjs");',
    'const core = require("../../../../clients/gui/scripts/support/core-process-fixture.cjs");',
    'const { spawn } = require("node:child_process"); spawn(binary, ["service", "start"]);',
    'childProcess.execFile(backend.binary, ["service", "start"]);',
    'const path = backend.binary; execFile(path, ["service", "start"]);',
    'spawn("/usr/bin/python3", ["-I", "-c", bridge, binary]);',
    "new CoreClient({});",
    "new WebSocket(project.endpoint, {});",
    "const url = new URL(project.endpoint); fetch(url, {});",
    "fetch(new URL(entry.endpoint));",
  ])("rejects Core ownership in a newly named module: %s", (source) => {
    const result = lint("no-workbench-core-owner", source, filename);
    expect(result.status).toBe(1);
    expect(result.output).toContain("areal(no-workbench-core-owner)");
  });
  test.each([
    'import type { CoreClient } from "@areal/runtime-client/core";',
    'import { type CoreClient } from "@areal/runtime-client/core";',
    'import { parseCoreCapabilities } from "@areal/runtime-client/capabilities";',
    'host("core.request", { projectId, method: "thread/read", params: {} });',
    'execFile("/usr/bin/git", ["status"]);',
    "new WebSocket(relayURL);",
    "new WebSocketServer({port:0});",
    "fetch(provider.endpoint, {});",
  ])("allows retained page/relay/utility behavior: %s", (source) => {
    expect(lint("no-workbench-core-owner", source, filename).status).toBe(0);
  });
  test("leaves the native shell scope to its existing rules", () => {
    expect(
      lint("no-workbench-core-owner", "new CoreClient({});", "clients/gui/app/src/native.ts")
        .status,
    ).toBe(0);
  });
});

describe("no-restyle", () => {
  const header =
    'import { Button, DialogContent } from "@areal/ui";\nimport { ChevronIcon } from "@areal/ui/icons";\n';
  test.each([
    '<Button variant="ghost" />',
    '<Button className="w-full sm:max-w-md flex-1" />',
    "<Button className={cn('mt-2', open && 'hidden')} />",
    '<ChevronIcon className="text-muted size-3" />',
    '<button className="text-red-500" style={{ color: "red" }} />',
  ])("accepts %s", (jsx) => {
    expect(lint("no-restyle", `${header}export const A = () => ${jsx};`).status).toBe(0);
  });
  test.each([
    '<Button className="rounded-full px-2" />',
    '<Button className="composer-primary-action" />',
    "<Button className={classes} />",
    "<DialogContent style={{ width: 400 }} />",
  ])("rejects %s", (jsx) => {
    const result = lint("no-restyle", `${header}export const A = () => ${jsx};`);
    expect(result.status).toBe(1);
    expect(result.output).toContain("R-CHECK-022");
  });
});

describe("no-unchecked-array-method", () => {
  test("project check reports array risk but rejects other lint and formatting failures", () => {
    const project = join(scratch, "array-method-config");
    mkdirSync(join(project, "renderer/src"), { recursive: true });
    writeFileSync(join(project, "package.json"), '{"private":true,"type":"module"}');
    copyFileSync(join(root, "vite.config.mts"), join(project, "vite.config.mts"));
    symlinkSync(join(root, "node_modules"), join(project, "node_modules"));
    symlinkSync(join(root, "oxlint-plugin-areal"), join(project, "oxlint-plugin-areal"));
    writeFileSync(
      join(project, "renderer/src/fixture.ts"),
      "export function view(item: Data) {\n  return (item.input ?? []).filter(Boolean);\n}\n",
    );
    const result = spawnSync(
      process.execPath,
      [join(root, "node_modules/vite-plus/bin/vp"), "check", "renderer/src/fixture.ts"],
      { cwd: project, encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain("areal(no-unchecked-array-method)");
    for (const [source, diagnostic] of [
      ["const unused = 1;\nexport {};\n", "no-unused-vars"],
      ["export const value=1", "format"],
    ]) {
      writeFileSync(join(project, "renderer/src/fixture.ts"), source);
      const rejected = spawnSync(
        process.execPath,
        [join(root, "node_modules/vite-plus/bin/vp"), "check", "renderer/src/fixture.ts"],
        { cwd: project, encoding: "utf8" },
      );
      expect(rejected.status, rejected.stdout + rejected.stderr).not.toBe(0);
      expect((rejected.stdout + rejected.stderr).toLowerCase()).toContain(diagnostic);
    }
  });

  test.each([
    "function view(item: Data) { return (item.input ?? []).filter(Boolean); }",
    "function view(item: any) { return item.input.map(render); }",
    "function view(item: Data) { return item.input?.some(test); }",
    "function view(item: Data) { return item.input['every'](test); }",
    "function view(item: Data) { const input = item.input; return input.find(test); }",
    "const value: any = external; value.reduce(sum);",
    "(external as any).flatMap(render);",
    "function view(item: Data | undefined) { return item?.input.map(render); }",
    "function view(item: Data) { if (Array.isArray(item.other)) return item.input.map(render); }",
    "function view(item: Data) { if (Array.isArray(item.input)) {} else return item.input.map(render); }",
    "function view(item: Data, Array: any) { if (Array.isArray(item.input)) return item.input.map(render); }",
  ])("rejects unchecked collection: %s", (source) => {
    const result = lint("no-unchecked-array-method", source);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("areal(no-unchecked-array-method)");
  });
  test.each([
    "function view(items: Item[] | undefined) { return (items ?? []).map(render); }",
    "function view(items: Array<Item>) { return items.filter(test); }",
    "function view(item: Data) { return (Array.isArray(item.input) ? item.input : []).map(render); }",
    "function view(item: Data) { if (Array.isArray(item.input)) return item.input.map(render); }",
    "function view(item: Data) { return Array.isArray(item.input) && item.input.map(render); }",
    "function view(item: Data) { return parsedItems(item.input).map(render); }",
    "function view(item: Data) { return item.title.trim(); }",
    "function view(item: Data[]) { return item.map(render); }",
    "function outer(item: Data) { function inner(item: Item[]) { return item.map(render); } }",
  ])("accepts typed or checked collection: %s", (source) => {
    const result = lint("no-unchecked-array-method", source);
    expect(result.status, result.output).toBe(0);
  });
});
