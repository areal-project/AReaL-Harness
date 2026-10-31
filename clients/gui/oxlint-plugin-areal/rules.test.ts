import { afterAll, describe, expect, test } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

function lint(rule: string, source: string) {
  const config = join(scratch, ".oxlintrc.json");
  writeFileSync(
    config,
    JSON.stringify({
      jsPlugins: [{ name: "areal", specifier: resolve(root, "oxlint-plugin-areal/index.ts") }],
      categories: { correctness: "off" },
      rules: { [`areal/${rule}`]: "error" },
    }),
  );
  const file = join(scratch, "fixture.tsx");
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
