import assert from "node:assert/strict";
import { readFile, readdir, mkdir, copyFile } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { root, writeOrCheck } from "./foundations.mjs";

async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? files(resolve(path, entry.name)) : resolve(path, entry.name),
      ),
    )
  ).flat();
}
function exported(source) {
  const file = ts.createSourceFile("entry.ts", source, ts.ScriptTarget.Latest, true);
  return new Set(
    file.statements
      .filter((node) => ts.isExportDeclaration(node) && !node.isTypeOnly)
      .flatMap((item) =>
        item.exportClause && ts.isNamedExports(item.exportClause)
          ? item.exportClause.elements
              .filter((element) => !element.isTypeOnly)
              .map((element) => element.name.text)
          : [],
      ),
  );
}
// Contract metadata is a small YAML-compatible subset: scalars and inline JSON arrays.
export function parseComponentMetadata(markdown, path) {
  const front = markdown.match(/^---\n([\s\S]+?)\n---\n/);
  assert.ok(front, `missing component metadata: ${path}`);
  const data = Object.fromEntries(
    front[1].split("\n").map((line) => line.split(/: (.*)/s).slice(0, 2)),
  );
  for (const key of ["id", "title", "summary", "status", "entry", "layer", "category"])
    assert.ok(data[key]?.trim(), `missing ${key}: ${path}`);
  for (const key of ["aliases", "related"]) {
    assert.ok(data[key], `missing ${key}: ${path}`);
    data[key] = JSON.parse(data[key]);
    assert.ok(
      Array.isArray(data[key]) && data[key].every((value) => typeof value === "string"),
      `invalid ${key}: ${path}`,
    );
  }
  data.exports = data.exports ? JSON.parse(data.exports) : [data.title];
  assert.ok(
    Array.isArray(data.exports) &&
      data.exports.includes(data.title) &&
      new Set(data.exports).size === data.exports.length &&
      data.exports.every((name) => typeof name === "string"),
    `invalid exports: ${path}`,
  );
  // 只强制入口和示例；其余小节有内容才写，空标题不保留。
  for (const section of ["何时使用", "示例"])
    assert.ok(markdown.includes(`\n## ${section}\n`), `missing section ${section}: ${path}`);
  const empty = markdown.match(/\n## ([^\n]+)\n\s*(?=\n## |$)/);
  assert.ok(!empty, `empty section ${empty?.[1]}: ${path}`);
  if (data.experimentalExports) {
    data.experimentalExports = JSON.parse(data.experimentalExports);
    assert.ok(
      data.entry === "compositions" &&
        Array.isArray(data.experimentalExports) &&
        data.experimentalExports.every(
          (name) => data.exports.includes(name) && name !== data.title,
        ),
      `invalid experimentalExports: ${path}`,
    );
  }
  return data;
}
export function verifyEntryAdmissions(components, entries, admissions) {
  for (const name of entries.compositions)
    assert.ok(
      admissions.some((item) => (item.exports ?? [item.id]).includes(name)),
      `unadmitted composition export ${name}`,
    );
  for (const item of admissions) {
    const component = components.find((component) => component.exports.includes(item.id));
    if (!component) continue;
    assert.ok(
      component.entry !== "experimental" &&
        !component.experimentalExports?.includes(item.id) &&
        !entries.experimental.has(item.id),
      `admitted package member ${item.id} uses experimental entry`,
    );
    assert.ok(
      entries.index.has(item.id) || entries.compositions.has(item.id),
      `missing admitted package export ${item.id}`,
    );
  }
}
export async function verifyExperimentalImports(guiRoot, allowlist) {
  const allowed = new Map(
    allowlist.map((item) => {
      assert.ok(
        Object.keys(item).sort().join(",") === "exitCondition,file,owner,symbol" &&
          Object.values(item).every((value) => typeof value === "string" && value.trim()),
        "experimental allowance requires file, symbol, owner, exitCondition",
      );
      return [`${item.file}#${item.symbol}`, item];
    }),
  );
  assert.equal(allowed.size, allowlist.length, "duplicate experimental allowance");
  const used = new Set();
  for (const path of (await files(resolve(guiRoot, "renderer/src"))).filter((path) =>
    /\.[jt]sx?$/.test(path),
  )) {
    const file = relative(guiRoot, path);
    const parsed = ts.createSourceFile(
      path,
      await readFile(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const retiredOrDeep = (entry) =>
      entry === "@areal/ui/wip" ||
      /^@areal\/ui\/(?:src|dist)(?:\/|$)/.test(entry ?? "") ||
      /^@areal\/ui\/[^/]+\//.test(entry ?? "");
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const entry = node.arguments[0].text;
        assert.ok(
          entry !== "@areal/ui/experimental" && !retiredOrDeep(entry),
          `dynamic UI import requires a supported static named entry: ${file} -> ${entry}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    for (const node of parsed.statements.filter(
      (node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node),
    )) {
      const entry = node.moduleSpecifier?.text;
      assert.ok(!retiredOrDeep(entry), `retired or deep UI import: ${file} -> ${entry}`);
      if (entry !== "@areal/ui/experimental") continue;
      const bindings = ts.isImportDeclaration(node)
        ? node.importClause?.namedBindings
        : node.exportClause;
      assert.ok(
        bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)),
        `experimental imports require named symbols: ${file}`,
      );
      if (file.startsWith("renderer/src/design-system/")) continue;
      for (const item of bindings.elements) {
        const key = `${file}#${item.propertyName?.text ?? item.name.text}`;
        assert.ok(allowed.has(key), `unlisted experimental import: ${key}`);
        used.add(key);
      }
    }
  }
  for (const key of allowed.keys())
    assert.ok(used.has(key), `stale experimental allowance: ${key}`);
  return used.size;
}
export function rewriteDocumentLinks(markdown, source, targets) {
  return markdown
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(/(\[[^\]\n]+\]\()([^\s)]+)(\))/g, (match, label, href, close) => {
            if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return match;
            const [, path, suffix] = href.match(/^([^?#]+)(.*)$/) ?? [];
            const target = path && targets.get(resolve(dirname(source), path));
            return target ? `${label}${target}${suffix}${close}` : match;
          }),
    )
    .join("");
}
export async function buildDocuments(check = false) {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(pkg.private, true, "workspace UI package stays private");
  const srcFiles = await files(resolve(root, "src"));
  const entries = Object.fromEntries(
    await Promise.all(
      ["index", "compositions", "experimental"].map(async (name) => [
        name,
        exported(await readFile(resolve(root, `src/${name}.ts`), "utf8")),
      ]),
    ),
  );
  for (const path of srcFiles.filter((path) => /\.[jt]sx?$/.test(path))) {
    const source = ts.createSourceFile(
      path,
      await readFile(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const specifiers = source.statements
      .filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      .map((node) => node.moduleSpecifier?.text)
      .filter(Boolean);
    for (const name of specifiers) {
      assert.ok(
        !/(?:renderer|app\/src|electron|^node:|^fs$|^path$|collaboration)/.test(name),
        `UI reverse/platform dependency: ${relative(root, path)} -> ${name}`,
      );
      if (name.startsWith(".")) {
        const target = resolve(dirname(path), name);
        assert.ok(target.startsWith(resolve(root, "src") + "/"), `import escapes UI: ${name}`);
        if (
          path.startsWith(resolve(root, "src/components") + "/") ||
          path === resolve(root, "src/index.ts")
        )
          assert.ok(
            !["conversation", "settings", "worktree", "workbench"].some((layer) =>
              target.startsWith(resolve(root, `src/${layer}`) + "/"),
            ),
            `core imports domain: ${relative(root, path)} -> ${name}`,
          );
      }
    }
  }
  const components = [];
  const documents = new Map([
    [resolve(root, "agent-guide.md"), "agent-guide.md"],
    [resolve(root, "skills/areal-ui-guide/SKILL.md"), "areal-ui-guide.md"],
    [resolve(root, "skills/areal-ui-critique/SKILL.md"), "areal-ui-critique.md"],
    [resolve(root, "README.md"), "README.md"],
    [resolve(root, "README.en.md"), "README.en.md"],
    [resolve(root, "token-reference.md"), "token-reference.md"],
    [resolve(root, "src/generated/tokens.md"), "tokens.md"],
    [resolve(root, "tokens.json"), "tokens.json"],
    [resolve(root, "experimental-allowlist.json"), "experimental-allowlist.json"],
  ]);
  for (const path of srcFiles.filter(
    (path) => path.endsWith(".md") && !path.includes("/src/generated/"),
  )) {
    const markdown = await readFile(path, "utf8");
    const data = parseComponentMetadata(markdown, path);
    assert.ok(/^[a-z][a-z-]+$/.test(data.id));
    assert.ok(
      ["core", "conversation", "settings", "worktree", "workbench"].includes(data.layer),
      `unknown layer: ${path}`,
    );
    assert.equal(
      data.layer,
      path.includes("/src/conversation/")
        ? "conversation"
        : path.includes("/src/settings/")
          ? "settings"
          : path.includes("/src/worktree/")
            ? "worktree"
            : path.includes("/src/workbench/")
              ? "workbench"
              : "core",
      `layer/source mismatch: ${path}`,
    );
    assert.ok(Object.hasOwn(entries, data.entry), `unknown entry: ${path}`);
    if (data.layer !== "core")
      assert.notEqual(data.entry, "index", "domain components cannot use the core entry");
    assert.ok(["stable", "experimental"].includes(data.status), `unknown API status: ${path}`);
    if (data.entry !== "compositions")
      assert.equal(
        data.status,
        data.entry === "index" ? "stable" : "experimental",
        `status/entry mismatch: ${path}`,
      );
    for (const name of data.exports)
      assert.ok(
        entries[data.experimentalExports?.includes(name) ? "experimental" : data.entry]?.has(name),
        `documented export does not exist: ${name}`,
      );
    const source = relative(root, path).replace(/\.md$/, ".tsx");
    const declaration = source.replace(/^src\//, "dist/").replace(/\.tsx$/, ".d.ts");
    const api = await readFile(resolve(root, declaration), "utf8");
    const document = `clients/gui/packages/ui/${relative(root, path)}`;
    components.push({ ...data, source, document, api });
    documents.set(path, `${data.id}.md`);
  }
  for (const [source, output] of documents)
    await writeOrCheck(
      resolve(root, "dist/docs", output),
      source.endsWith(".md")
        ? rewriteDocumentLinks(await readFile(source, "utf8"), source, documents)
        : await readFile(source, "utf8"),
      check,
    );
  components.sort((a, b) => a.id.localeCompare(b.id));
  for (const component of components)
    for (const id of component.related)
      assert.ok(
        components.some((item) => item.id === id),
        `unknown related component ${id}: ${component.id}`,
      );
  for (const [entry, names] of Object.entries(entries))
    for (const name of names) {
      if (/^[A-Z]/.test(name))
        assert.ok(
          components.filter(
            (component) =>
              component.exports.includes(name) &&
              (component.experimentalExports?.includes(name) ? "experimental" : component.entry) ===
                entry,
          ).length === 1,
          `missing contract for export ${name}`,
        );
    }
  const registry = JSON.parse(
    await readFile(resolve(root, "../../design-system/registry.json"), "utf8"),
  );
  verifyEntryAdmissions(components, entries, registry.baseCandidate.admissions);
  await verifyExperimentalImports(
    resolve(root, "../.."),
    JSON.parse(await readFile(resolve(root, "experimental-allowlist.json"), "utf8")),
  );
  await writeOrCheck(
    resolve(root, "dist/components.json"),
    JSON.stringify(
      { schemaVersion: 1, name: pkg.name, version: pkg.version, private: pkg.private, components },
      null,
      2,
    ) + "\n",
    check,
  );
  const index =
    `# ${pkg.name} ${pkg.version}\n\nLocal workspace package; private, not published.\n\n- [Agent guide](docs/ui/agent-guide.md): adoption order, source owners and verification.\n- [Skill: areal-ui-guide](docs/ui/areal-ui-guide.md): reading order, override-your-priors table and component migration steps.\n- [Skill: areal-ui-critique](docs/ui/areal-ui-critique.md): evidence-first visual review in light and dark themes.\n- [Token reference](docs/ui/tokens.md): every CSS variable with default value and purpose.\n` +
    components
      .map(
        (component) =>
          `- [${component.title}](docs/ui/${component.id}.md): ${component.summary} (${component.status}, @areal/ui${component.entry === "index" ? "" : `/${component.entry}`}).`,
      )
      .join("\n") +
    "\n";
  await writeOrCheck(resolve(root, "dist/llms.txt"), index, check);
  if (!check)
    for (const path of srcFiles.filter((path) => path.endsWith(".css"))) {
      const output = resolve(root, "dist", relative(resolve(root, "src"), path));
      await mkdir(dirname(output), { recursive: true });
      await copyFile(path, output);
    }
  return components.length;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(
    JSON.stringify({
      passed: true,
      components: await buildDocuments(process.argv.includes("--check")),
    }),
  );
}
