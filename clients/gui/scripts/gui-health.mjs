import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { collectUiAdoption } from "./design-system-maturity.mjs";
import { readTestManifest } from "./test-manifest.mjs";
import { collectDesignRuleMetrics } from "./design-rules.mjs";

// PR #128 的人工审阅声明，不是授权验证。新基线进入 base 后自然失效，可移除此迁移记录。
const reviewedDocBudgetTransition = Object.freeze({
  metric: "activeDesignDocBytes",
  from: 262924,
  to: 269714,
  direction: "down",
  owner: "design/ clients/gui/design-system",
  reason: "Bilingual plugin resource specifications and disclosure/copy rules; no extra headroom",
  review: "PR #128: owner-approved document-only budget adjustment",
});

export function reviewedBaselineTransition(name, before, current) {
  const review = reviewedDocBudgetTransition;
  return name === review.metric &&
    before?.value === review.from &&
    current?.value === review.to &&
    before.direction === review.direction &&
    current.direction === review.direction &&
    before.owner === review.owner &&
    current.owner === review.owner
    ? review
    : null;
}

const gui = fileURLToPath(new URL("../", import.meta.url));
const sourceExtension = /\.(?:cjs|mjs|js|jsx|ts|tsx|css)$/;
const excluded =
  /(?:^|\/)(?:vendor|generated|dist|node_modules|design-system)(?:\/|$)|(?:^|\/)i18n\/messages\/|\.(?:test|spec)\./;
const lines = (source) =>
  (source.match(/\n/g)?.length ?? 0) + (source.length > 0 && !source.endsWith("\n") ? 1 : 0);
const sum = (files) => files.reduce((total, file) => total + file.lines, 0);
const row = (value, direction, owner, evidence) => ({ value, direction, owner, evidence });

async function filesAt(root, dir) {
  const entries = await readdir(resolve(root, dir), { recursive: true });
  return entries
    .filter((file) => sourceExtension.test(file) && !excluded.test(`${dir}/${file}`))
    .filter(
      (file) =>
        dir !== "packages" ||
        /^[^/]+\/(?:src|client)\//.test(file) ||
        (/^[^/]+\/[^/]+$/.test(file) &&
          !/(?:^|\/)(?:build\.[^/]+|[^/]+\.config\.[^/]+|[^/]+\.d\.[cm]?ts)$/.test(file)),
    )
    .sort()
    .map((file) => `${dir}/${file}`);
}

export async function collectHealth({ root = gui } = {}) {
  const paths = (
    await Promise.all(["app/src", "renderer/src", "packages"].map((dir) => filesAt(root, dir)))
  ).flat();
  const files = await Promise.all(
    paths.map(async (path) => {
      const source = await readFile(resolve(root, path), "utf8");
      return { path, source, lines: lines(source) };
    }),
  );
  const main = files.filter(
    (file) => file.path.startsWith("app/src/") && !file.path.endsWith(".css"),
  );
  const renderer = files.filter((file) => file.path.startsWith("renderer/src/"));
  const app = renderer.find((file) => file.path === "renderer/src/App.tsx");
  const allScripts = (await readdir(resolve(root, "scripts"), { recursive: true })).filter((file) =>
    sourceExtension.test(file),
  );
  const scriptSources = await Promise.all(
    allScripts.map((file) => readFile(resolve(root, "scripts", file), "utf8")),
  );
  const literal = JSON.parse(
    await readFile(resolve(root, "design-system/literal-baseline.json"), "utf8"),
  );
  const literalTotal = Object.values(literal.total);
  if (!literalTotal.every((value) => Number.isFinite(value) && value >= 0))
    throw new Error("Invalid literal-baseline totals");
  const manifestSource = await readFile(resolve(root, "scripts/test-manifest.json"), "utf8").catch(
    (error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  const manifest = manifestSource === null ? null : await readTestManifest(root);
  const packageScripts = Object.keys(
    JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).scripts ?? {},
  ).filter((script) => script.startsWith("test:"));
  const adoption = await collectUiAdoption({ root });
  const documentMetrics = await collectDesignRuleMetrics({ root: resolve(root, "../..") });
  const experimentalSource = await readFile(
    resolve(root, "packages/ui/experimental-allowlist.json"),
    "utf8",
  ).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const experimental = experimentalSource === null ? null : JSON.parse(experimentalSource);
  if (experimental !== null && !Array.isArray(experimental))
    throw new Error("Invalid experimental import allowance");
  const accessibilitySource = await readFile(
    resolve(root, "design-system/accessibility-baseline.json"),
    "utf8",
  ).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const accessibility = accessibilitySource === null ? null : JSON.parse(accessibilitySource);
  const lintSources = [...files.map((file) => file.source), ...scriptSources];
  const checkedMainFiles = main.filter(
    (file) => /@ts-check\b/.test(file.source) || /\.tsx?$/.test(file.path),
  ).length;
  const metrics = {
    mainCheckedFiles: row(
      checkedMainFiles,
      "up",
      "app/src",
      "Files with @ts-check or TypeScript extension",
    ),
    mainTypeCoverage: row(
      main.length ? checkedMainFiles / main.length : null,
      "up",
      "app/src",
      "Checked Main source files / all owned Main source files; native typecheck separately validates the program",
    ),
    appLines: row(
      app ? app.lines : null,
      "down",
      "renderer/src/App.tsx",
      "Physical lines; missing owner is unknown",
    ),
    appHooks: row(
      app
        ? [
            ...app.source.matchAll(
              /\buse(?:State|Ref|Effect|Callback|Memo|Reducer|LayoutEffect|Context)\b/g,
            ),
          ].length
        : null,
      "down",
      "renderer/src/App.tsx",
      "Lexical hook references, including imports, matching G0 reproduction",
    ),
    uiAdoptionRatio: row(
      adoption.files ? adoption.consumers / adoption.files : null,
      "up",
      "scripts/design-system-maturity.mjs",
      "Production TSX consumers / production TSX files; follows local re-exports",
    ),
    wipFiles: row(
      renderer.filter((file) => /["']@areal\/ui\/wip["']/.test(file.source)).length,
      "down",
      "renderer/src",
      "Production files importing or re-exporting the wip entry",
    ),
    experimentalImports: row(
      experimental?.length ?? null,
      "down",
      "packages/ui/experimental-allowlist.json",
      "File/symbol allowances; verify:design separately proves exact correspondence to imports",
    ),
    tsIgnores: row(
      files.reduce(
        (total, file) =>
          total +
          [...file.source.matchAll(/(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g)].reduce(
            (count, comment) => count + [...comment[0].matchAll(/@ts-ignore\b/g)].length,
            0,
          ),
        0,
      ),
      "down",
      "app/src renderer/src packages",
      "Production type-ignore directives, excluding tests/generated/vendor",
    ),
    tsExpectErrors: row(
      files.reduce(
        (total, file) =>
          total +
          [...file.source.matchAll(/(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g)].reduce(
            (count, comment) => count + [...comment[0].matchAll(/@ts-expect-error\b/g)].length,
            0,
          ),
        0,
      ),
      "down",
      "app/src renderer/src packages",
      "Production expected-error directives, excluding tests/generated/vendor",
    ),
    rendererCssLines: row(
      sum(renderer.filter((file) => file.path.endsWith(".css"))),
      "down",
      "renderer/src",
      "Physical CSS lines excluding design previews",
    ),
    nonLayoutCssFiles: row(
      renderer.filter((file) => file.path.endsWith(".css") && !file.path.endsWith(".layout.css"))
        .length,
      "down",
      "renderer/src",
      "Production CSS files other than explicitly owned layout styles",
    ),
    literalDebt: row(
      literalTotal.reduce((total, value) => total + value, 0),
      "down",
      "design-system/literal-baseline.json",
      "Existing literal audit baseline total; run its audit separately for current-source validation",
    ),
    privateTmpHardcodes: row(
      // 这里匹配待审计的源码文本，不是供文件系统访问的临时路径。
      scriptSources.filter((source) => /\/private\/tmp/.test(source)).length,
      "down",
      "scripts",
      "Number of script source files containing the macOS private temporary-directory literal, including tests",
    ),
    activeDesignDocBytes: row(
      documentMetrics.activeDesignDocBytes,
      "down",
      "design/ clients/gui/design-system",
      "Actual active Markdown bytes excluding archive; identical original D5 scope",
    ),
    a11yModerateIssues: row(
      accessibility?.moderateIssues ?? null,
      "down",
      "design-system/accessibility-baseline.json",
      "Reviewed moderate issue budget; test:design validates actual mounted preview findings",
    ),
    contrastExceptions: row(
      accessibility?.contrastExceptions.length ?? null,
      "down",
      "design-system/accessibility-baseline.json",
      "Registered default-theme contrast exceptions; custom diagnostics do not count as exceptions",
    ),
    lintDisables: row(
      lintSources.reduce(
        (total, source) =>
          total +
          [...source.matchAll(/(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g)].reduce(
            (count, match) =>
              count +
              [...match[0].matchAll(/\b(?:eslint|oxlint)-disable(?:-next-line|-line)?\b/g)].length,
            0,
          ),
        0,
      ),
      "down",
      "app/src renderer/src packages scripts",
      "Disable directives inside line/block comments",
    ),
    unregisteredTests: row(
      manifest === null
        ? null
        : packageScripts.filter((script) => !manifest.some((entry) => entry.script === script))
            .length,
      "down",
      "scripts/test-manifest.json",
      "GUI root package.json test:* without a registration; null before E5",
    ),
    rendererUnitTestFiles: row(
      (await readdir(resolve(root, "renderer/src"), { recursive: true })).filter(
        (file) =>
          /\.test\.[cm]?[jt]sx?$/.test(file) && !excluded.test(file.replace(/\.test\./, ".")),
      ).length,
      "up",
      "renderer/src",
      "Renderer test source files, excluding preview/generated/vendor",
    ),
    flakyTests: row(
      manifest === null ? null : manifest.filter((entry) => entry.flaky === true).length,
      "down",
      "scripts/test-manifest.json",
      "Explicit flaky registrations; unmeasured tests are not declared non-flaky",
    ),
  };
  const gitRoot = execFileSyncResult(["rev-parse", "--show-toplevel"], root);
  return {
    schemaVersion: 1,
    revision: gitRoot ? execFileSyncResult(["rev-parse", "HEAD"], root) : null,
    sourceDigest: createHash("sha256")
      .update(files.map((file) => `${file.path}\0${file.source}\0`).join(""))
      .digest("hex"),
    scope:
      "GUI production app/src, renderer/src, packages/*/{src,client}, and package-root implementations; excludes package build/config/declaration tooling, vendor/generated/design previews/i18n messages/tests; manifest covers GUI root package only",
    metrics,
    counts: {
      mainSourceLines: sum(main),
      uiCssLines: sum(
        files.filter(
          (file) => file.path.startsWith("packages/ui/src/") && file.path.endsWith(".css"),
        ),
      ),
      mainSourceFiles: main.length,
      productionSourceFiles: files.length,
      productionTsxFiles: adoption.files,
      uiConsumerFiles: adoption.consumers,
      testScripts: packageScripts.length,
      scriptSourceFiles: allScripts.length,
      userEntryDocBytes: documentMetrics.userEntryDocBytes,
    },
    literals: literal.total,
    largeFiles: Object.fromEntries(
      files.filter((file) => file.lines > 1000).map((file) => [file.path, file.lines]),
    ),
    sourceLines: Object.fromEntries(files.map((file) => [file.path, file.lines])),
  };
}

function execFileSyncResult(args, root) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

// 继承问题单独归因，但仍按已审核基准判定失败，不能借比较基点自动豁免。
async function baseHealth(base, root) {
  const gitRoot = execFileSyncResult(["rev-parse", "--show-toplevel"], root);
  if (!gitRoot) throw new Error(`Unavailable baseline base ${base}`);
  const gui = relative(gitRoot, root).replaceAll("\\", "/");
  const design = relative(gitRoot, resolve(root, "../../design")).replaceAll("\\", "/");
  const directory = await mkdtemp(join(tmpdir(), "areal-health-base-"));
  try {
    const archive = execFileSync("git", ["archive", "--format=tar", base, "--", gui, design], {
      cwd: gitRoot,
      maxBuffer: 1 << 30,
    });
    execFileSync("tar", ["-x", "-C", directory], { input: archive });
    return await collectHealth({ root: join(directory, gui) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function inheritedFrom(failure, before) {
  const old = failure.metric.startsWith("source:")
    ? before.sourceLines[failure.metric.slice("source:".length)]
    : before.metrics[failure.metric]?.value;
  if (!Number.isFinite(old)) return false;
  return failure.direction === "up" ? failure.current >= old : failure.current <= old;
}

function validateBaseline(baseline) {
  if (
    baseline.$schemaVersion !== 1 ||
    !baseline.$sourceCaps ||
    typeof baseline.$sourceCaps !== "object"
  )
    throw new Error("Invalid health baseline schema");
  for (const [name, item] of Object.entries(baseline).filter(([name]) => !name.startsWith("$"))) {
    if (
      !item ||
      !["up", "down"].includes(item.direction) ||
      typeof item.owner !== "string" ||
      (item.value !== null && !Number.isFinite(item.value))
    )
      throw new Error(`Invalid health baseline metric ${name}`);
  }
  if (!Object.values(baseline.$sourceCaps).every((value) => Number.isFinite(value) && value >= 0))
    throw new Error("Invalid source path caps");
  return baseline;
}

function compare(report, baseline) {
  const failures = [];
  for (const [name, metric] of Object.entries(report.metrics)) {
    const before = baseline[name];
    if (!before) {
      failures.push({ metric: name, reason: "missing baseline metric" });
      continue;
    }
    if (metric.direction !== before.direction || metric.owner !== before.owner)
      failures.push({ metric: name, reason: "baseline owner or direction changed" });
    if (metric.value === null || before.value === null) {
      failures.push({
        metric: name,
        baseline: before.value,
        current: metric.value,
        direction: metric.direction,
        reason: "unknown metric",
      });
      continue;
    }
    if (metric.direction === "down" ? metric.value > before.value : metric.value < before.value)
      failures.push({
        metric: name,
        baseline: before.value,
        current: metric.value,
        direction: metric.direction,
      });
  }
  for (const [path, current] of Object.entries(report.sourceLines)) {
    const cap = baseline.$sourceCaps[path];
    if (current > (cap === undefined ? 800 : Math.max(800, cap)))
      failures.push({
        metric: `source:${path}`,
        baseline: cap ?? 800,
        current,
        direction: "down",
        reason:
          cap === undefined
            ? "new production source exceeds 800 lines"
            : "source path cap increased",
      });
  }
  return failures;
}

function baselineFrom(report, previous) {
  return {
    $schemaVersion: 1,
    $revision: report.revision,
    ...Object.fromEntries(
      Object.entries(report.metrics).map(([name, metric]) => [
        name,
        { value: metric.value, direction: metric.direction, owner: metric.owner },
      ]),
    ),
    $sourceCaps: Object.fromEntries(
      [
        ...new Set([
          ...Object.keys(previous?.$sourceCaps ?? {}),
          ...Object.keys(report.sourceLines),
        ]),
      ]
        .sort()
        .map((path) => [path, report.sourceLines[path] ?? 0]),
    ),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const rootIndex = args.indexOf("--root");
  const root = await realpath(
    resolve(value("--root") ?? (rootIndex >= 0 ? args[rootIndex + 1] : gui)),
  );
  const report = await collectHealth({ root });
  const write = args.includes("--write");
  if (!write && !args.includes("--check")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const path = resolve(root, "health-baseline.json");
  const stored = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT" && write) return null;
    throw error;
  });
  const baseline = stored === null ? null : validateBaseline(JSON.parse(stored));
  const allowed = new Set(
    args
      .filter((arg) => arg.startsWith("--allow-regression="))
      .map((arg) => arg.slice("--allow-regression=".length)),
  );
  const names = new Set([
    ...Object.keys(report.metrics),
    ...Object.keys(report.sourceLines).map((path) => `source:${path}`),
  ]);
  for (const name of allowed)
    if (!names.has(name)) throw new Error(`Unknown regression exception ${name}`);
  const failures = baseline ? compare(report, baseline) : [];
  const base = value("--base") ?? process.env.AREAL_DESIGN_BASE;
  const reviewedTransitions = [];
  if (base && baseline) {
    const gitRoot = execFileSyncResult(["rev-parse", "--show-toplevel"], root);
    if (!gitRoot) throw new Error(`Unavailable baseline base ${base}`);
    const before = JSON.parse(
      execFileSync("git", ["show", `${base}:${relative(gitRoot, path).replaceAll("\\", "/")}`], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    validateBaseline(before);
    for (const [name, current] of Object.entries(baseline).filter(
      ([name]) => !name.startsWith("$"),
    )) {
      const old = before[name];
      if (
        old &&
        (old.direction !== current.direction ||
          old.owner !== current.owner ||
          current.value === null ||
          (old.direction === "down" ? current.value > old.value : current.value < old.value))
      ) {
        const review = reviewedBaselineTransition(name, old, current);
        if (review) reviewedTransitions.push(review);
        else
          failures.push({
            metric: name,
            baseline: old.value,
            current: current.value,
            direction: old.direction,
            reason: "baseline relaxed against base",
          });
      }
    }
    for (const [path, cap] of Object.entries(before.$sourceCaps))
      if (
        !(path in baseline.$sourceCaps) ||
        Math.max(800, baseline.$sourceCaps[path]) > Math.max(800, cap)
      )
        failures.push({
          metric: `source:${path}`,
          reason: "baseline source cap relaxed against base",
        });
    for (const [path, cap] of Object.entries(baseline.$sourceCaps))
      if (!(path in before.$sourceCaps) && cap > 800)
        failures.push({
          metric: `source:${path}`,
          reason: "baseline added oversized source against base",
        });
  }
  const regressions = failures.filter(
    (failure) => !failure.reason?.includes("relaxed") && Number.isFinite(failure.current),
  );
  const before =
    !write && base && baseline && regressions.length ? await baseHealth(base, root) : null;
  const inherited = before ? regressions.filter((failure) => inheritedFrom(failure, before)) : [];
  inherited.forEach((failure) =>
    console.warn(
      JSON.stringify({
        ...failure,
        inherited: `base ${base} already exceeds the reviewed baseline`,
      }),
    ),
  );
  const rejected = failures.filter((failure) => !allowed.has(failure.metric));
  if (rejected.length) {
    rejected.forEach((failure) => console.error(JSON.stringify(failure)));
    process.exitCode = 1;
    return;
  }
  if (write) {
    const next = baselineFrom(report, baseline);
    await writeFile(path, JSON.stringify(next, null, 2) + "\n");
  }
  console.log(
    JSON.stringify({
      passed: true,
      written: write,
      reviewedTransitions,
      allowedRegressions: failures.filter((failure) => allowed.has(failure.metric)),
      inheritedRegressions: inherited,
      metrics: report.metrics,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
