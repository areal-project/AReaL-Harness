"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync, mkdtempSync, writeFileSync, rmSync, readdirSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const rendererRequire = createRequire(resolve("renderer/package.json"));
const ts = rendererRequire("typescript");
const contractPath = resolve("packages/workbench/client/desktop-contract.cjs");
const commandDefinitionPath = resolve("packages/workbench/client/desktop-contract/transport.cjs");
const mainPath = resolve("app/src/core/main.cjs");
const preloadPath = resolve("app/src/core/preload.cjs");
const { commandDefinitions } = require(contractPath);
const source = (path, text = readFileSync(path, "utf8")) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const visit = (node, accept) => {
  accept(node);
  ts.forEachChild(node, (child) => visit(child, accept));
};
const sorted = (values) => [...values].sort();

function mainSource(text = readFileSync(mainPath, "utf8")) {
  const snapshots = readFileSync(resolve("app/src/core/snapshots/host.cjs"), "utf8");
  return source(mainPath, text + "\n" + snapshots);
}

function maps(override) {
  const options = {
    allowJs: true,
    checkJs: false,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    types: [],
  };
  const host = ts.createCompilerHost(options),
    original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, ...args) =>
    path === contractPath && override !== undefined
      ? ts.createSourceFile(path, override, args[0], true)
      : original(path, ...args);
  const program = ts.createProgram([contractPath], options, host),
    checker = program.getTypeChecker();
  const file = program.getSourceFile(contractPath),
    module = checker.getSymbolAtLocation(file);
  const exported = checker.getExportsOfModule(module);
  return Object.fromEntries(
    ["DesktopInvokeArguments", "DesktopSendArguments", "DesktopEventArguments"].map((name) => {
      const symbol = exported.find((item) => item.name === name);
      assert.ok(symbol, `missing shared IPC owner ${name}`);
      const properties = checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol));
      return [
        name,
        { keys: new Set(properties.map((property) => property.name)), properties, file },
      ];
    }),
  );
}

function calls(file, kinds) {
  const result = new Map(kinds.map((kind) => [kind, new Set()]));
  visit(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const name = ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : ts.isIdentifier(node.expression)
        ? node.expression.text
        : "";
    if (!result.has(name)) return;
    const channel = name === "sendDesktopEvent" ? node.arguments[1] : node.arguments[0];
    if (channel && ts.isStringLiteralLike(channel) && channel.text.startsWith("areal-core:"))
      result.get(name).add(channel.text);
  });
  return result;
}
function union(...sets) {
  return new Set(sets.flatMap((set) => [...set]));
}
function assertChannels(contract, main, preload) {
  const registered = calls(main, [
    "handle",
    "handleDesktopIpc",
    "on",
    "onDesktopIpc",
    "send",
    "sendDesktopEvent",
  ]);
  const consumed = calls(preload, [
    "invoke",
    "invokeDesktop",
    "send",
    "sendDesktop",
    "on",
    "onDesktopEvent",
  ]);
  assert.deepEqual(
    sorted(union(registered.get("handle"), registered.get("handleDesktopIpc"))),
    sorted(contract.DesktopInvokeArguments.keys),
    "Main invoke registration differs from shared IPC owner",
  );
  assert.deepEqual(
    sorted(union(consumed.get("invoke"), consumed.get("invokeDesktop"))),
    sorted(contract.DesktopInvokeArguments.keys),
    "preload invoke differs from shared IPC owner",
  );
  assert.deepEqual(
    sorted(union(registered.get("on"), registered.get("onDesktopIpc"))),
    sorted(contract.DesktopSendArguments.keys),
    "Main send registration differs from shared IPC owner",
  );
  assert.deepEqual(
    sorted(union(consumed.get("send"), consumed.get("sendDesktop"))),
    sorted(contract.DesktopSendArguments.keys),
    "preload send differs from shared IPC owner",
  );
  assert.deepEqual(
    sorted(union(registered.get("send"), registered.get("sendDesktopEvent"))),
    sorted(contract.DesktopEventArguments.keys),
    "Main event publication differs from shared IPC owner",
  );
  assert.deepEqual(
    sorted(union(consumed.get("on"), consumed.get("onDesktopEvent"))),
    sorted(contract.DesktopEventArguments.keys),
    "preload subscription differs from shared IPC owner",
  );
}

test("shared IPC types cover Main registration and preload directions without importing Electron", () => {
  assertChannels(maps(), mainSource(), source(preloadPath));
});
test("deleting a contract channel and adding a Main handler both fail the consistency gate", () => {
  const contract = maps(),
    property = contract.DesktopInvokeArguments.properties.find(
      (item) => item.name === "areal-core:command",
    );
  assert.ok(property);
  const declaration = property.declarations[0],
    file = contract.DesktopInvokeArguments.file;
  const line = file.getLineAndCharacterOfPosition(declaration.getStart(file)).line;
  const starts = file.getLineStarts(),
    text = file.text.slice(0, starts[line]) + file.text.slice(starts[line + 1]);
  assert.throws(() => assertChannels(maps(text), mainSource(), source(preloadPath)), /IPC owner/);
  const extra = mainSource(
    readFileSync(mainPath, "utf8") +
      '\nhandleDesktopIpc("areal-core:unexpected", () => undefined);\n',
  );
  assert.throws(() => assertChannels(contract, extra, source(preloadPath)), /IPC owner/);
});

test("native TypeScript rejects wrong invoke arity and keeps raw replies unknown", () => {
  const root = mkdtempSync(join(tmpdir(), "areal-ipc-types-"));
  try {
    const fixture = join(root, "fixture.mts");
    const imports = `import type { DesktopInvoke } from ${JSON.stringify(contractPath)};\ndeclare const invoke: DesktopInvoke;\n`;
    const valid =
      'await invoke("areal-core:command", "list", {});\nawait invoke("areal-core:snapshot");\n';
    const config = join(root, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({ extends: resolve("app/tsconfig.json"), include: [], files: [fixture] }),
    );
    const native = resolve("renderer/node_modules/@typescript/native/bin/tsc");
    const compile = (text) => {
      writeFileSync(fixture, imports + text);
      return spawnSync(
        process.execPath,
        [native, "--ignoreConfig", "-p", config, "--pretty", "false"],
        { encoding: "utf8" },
      );
    };
    const accepted = compile(valid);
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    const rejected = compile(
      valid +
        'await invoke("areal-core:command", "list");\n(await invoke("areal-core:snapshot")).projects;\n',
    );
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
    assert.match(rejected.stdout, /fixture\.mts\(5,7\): error TS2554/);
    assert.match(rejected.stdout, /fixture\.mts\(6,1\): error TS2571/);
    assert.equal(rejected.stdout.trim().split("\n").length, 2, rejected.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function commandBranches(file) {
  const names = new Set();
  visit(file, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === "name" &&
      ts.isStringLiteralLike(node.right)
    )
      names.add(node.right.text);
    if (
      ts.isSwitchStatement(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "name"
    )
      for (const clause of node.caseBlock.clauses)
        if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression))
          names.add(clause.expression.text);
  });
  return names;
}

function commandNames(file) {
  let definitions;
  visit(file, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "commandDefinitions"
    ) {
      assert.ok(ts.isCallExpression(node.initializer));
      definitions = node.initializer.arguments[0];
    }
  });
  assert.ok(definitions && ts.isObjectLiteralExpression(definitions));
  return definitions.properties;
}
function assertCommands(file) {
  const declared = commandNames(file).map((property) => property.name.text);
  const dispatched = union(
    commandBranches(mainSource()),
    commandBranches(source(resolve("../../services/workbench/src/desktop/core/backend.cjs"))),
  );
  assert.deepEqual(
    sorted(declared),
    sorted(dispatched),
    "Desktop command owner differs from actual dispatch branches",
  );
}
test("deleting a command from the validator owner fails the actual dispatch consistency gate", () => {
  const file = source(commandDefinitionPath);
  assertCommands(file);
  const property = commandNames(file).find((item) => item.name.text === "prepareCreator");
  assert.ok(property);
  const changed =
    file.text.slice(0, property.getStart(file)) + file.text.slice(property.getEnd() + 1);
  assert.throws(
    () => assertCommands(source(commandDefinitionPath, changed)),
    /Desktop command owner/,
  );
});

// Parse the Rust catalog macro's literal grammar, not a second list of Core methods.
function rustCatalog(path) {
  const scan = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    readFileSync(path, "utf8"),
  );
  const tokens = [];
  for (let kind = scan.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scan.scan())
    tokens.push({ kind, text: scan.getTokenText(), value: scan.getTokenValue() });
  const at = tokens.findIndex(
    (token, index) =>
      token.text === "method_catalog" &&
      tokens[index + 1]?.text === "!" &&
      tokens[index + 2]?.text === "{",
  );
  assert.ok(at >= 0, "Core method catalog macro missing");
  const methods = new Set();
  let index = at + 3;
  while (tokens[index]?.text !== "}") {
    const method = tokens[index++];
    assert.equal(method.kind, ts.SyntaxKind.StringLiteral);
    assert.equal(tokens[index++].text, "=>");
    assert.ok(["Read", "Subscription", "Mutation"].includes(tokens[index++].text));
    if (tokens[index].text === ",") {
      index++;
      assert.ok(["Thread", "Task", "Management"].includes(tokens[index++].text));
    }
    assert.equal(tokens[index++].text, ";");
    assert.ok(!methods.has(method.value));
    methods.add(method.value);
  }
  return methods;
}
function coreTargets(file, checker) {
  const methods = new Set(),
    templates = [];
  const seen = new Set();
  const strings = (node) => {
    if (seen.has(node)) return;
    seen.add(node);
    visit(node, (child) => {
      if (ts.isStringLiteralLike(child) && child.text.includes("/")) methods.add(child.text);
      if (
        ts.isTemplateExpression(child) &&
        child.templateSpans.length === 1 &&
        child.head.text.includes("/")
      )
        templates.push({ prefix: child.head.text, suffix: child.templateSpans[0].literal.text });
      if (ts.isIdentifier(child)) {
        const declaration = checker.getSymbolAtLocation(child)?.valueDeclaration;
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
          strings(declaration.initializer);
        if (
          declaration &&
          ts.isBindingElement(declaration) &&
          ts.isVariableDeclaration(declaration.parent.parent) &&
          declaration.parent.parent.initializer
        )
          strings(declaration.parent.parent.initializer);
      }
    });
  };
  visit(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (
      ts.isParenthesizedExpression(callee) &&
      ts.isBinaryExpression(callee.expression) &&
      callee.expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      ts.isCallExpression(callee.expression.right) &&
      ts.isPropertyAccessExpression(callee.expression.right.expression) &&
      callee.expression.right.expression.name.text === "bind" &&
      ts.isPropertyAccessExpression(callee.expression.right.expression.expression) &&
      callee.expression.right.expression.expression.name.text === "request" &&
      node.arguments[0]
    )
      strings(node.arguments[0]);
    if (!ts.isPropertyAccessExpression(node.expression)) return;
    if (node.expression.name.text === "request" && node.arguments[0]) strings(node.arguments[0]);
    if (["submit", "readSubmission"].includes(node.expression.name.text) && node.arguments[1])
      strings(node.arguments[1]);
  });
  return { methods, templates };
}

test("Core target scanner recognizes a bound request without collecting unrelated callbacks", () => {
  const root = mkdtempSync(join(tmpdir(), "areal-ipc-targets-"));
  try {
    const path = join(root, "fixture.cjs");
    writeFileSync(
      path,
      'const method = "areal/thread/read";\n' +
        "(terminalRequest ?? current.request.bind(current))(method);\n" +
        'unrelated("areal/unrelated/read");\n' +
        '(callback ?? current.other.bind(current))("areal/other/read");\n',
    );
    const program = ts.createProgram([path], { allowJs: true, noResolve: true, noLib: true });
    assert.deepEqual(
      sorted(coreTargets(program.getSourceFile(path), program.getTypeChecker()).methods),
      ["areal/thread/read"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop commands map to their own dispatch layer and Core catalog through actual RPC targets", () => {
  const main = commandBranches(mainSource()),
    backend = commandBranches(
      source(resolve("../../services/workbench/src/desktop/core/backend.cjs")),
    );
  for (const [name, [owner]] of Object.entries(commandDefinitions))
    assert.ok(
      (owner === "main" ? main : backend).has(name),
      `${owner} command lacks a dispatch branch: ${name}`,
    );
  const files = ["app/src/core", "../../services/workbench/src/desktop/core"].flatMap((directory) =>
    readdirSync(resolve(directory))
      .filter((name) => name.endsWith(".cjs"))
      .map((name) => resolve(directory, name)),
  );
  const program = ts.createProgram(files, {
      allowJs: true,
      noResolve: true,
      noLib: true,
      types: [],
    }),
    checker = program.getTypeChecker();
  const targets = new Set(),
    templates = [];
  for (const path of files) {
    const found = coreTargets(program.getSourceFile(path), checker);
    for (const method of found.methods) targets.add(method);
    templates.push(...found.templates);
  }
  const core = rustCatalog(resolve("../../core/app-server/src/desktop.rs"));
  assert.ok(
    !core.has("create") && !Object.hasOwn(commandDefinitions, "areal/thread/start"),
    "Desktop and Core namespaces must remain distinct",
  );
  const unmapped = [...core].filter(
    (method) =>
      // Web 经 Core 查询 Host；GUI Main 直接调用 Host，不经过此 Core 代理。
      method !== "areal/host/status" &&
      !targets.has(method) &&
      !templates.some(({ prefix, suffix }) => method.startsWith(prefix) && method.endsWith(suffix)),
  );
  // Worktree 执行由 Host 直接调用 Core；GUI 只调用 Host 目录，模型详情由列表提供。
  assert.deepEqual(unmapped, [
    "areal/worktree/read",
    "areal/worktree/command",
    "areal/provider/read",
  ]);
});

test("window close confirmation belongs to the original frame and request", async () => {
  const { EventEmitter } = require("node:events");
  const { runInNewContext } = require("node:vm");
  const compiled = ts.transpileModule(
    readFileSync(resolve("app/src/ipc/window-close.ts"), "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const exports = {};
  runInNewContext(compiled, { exports, setTimeout, clearTimeout });
  const owner = Object.assign(new EventEmitter(), {
    mainFrame: { url: "areal-ui://app/" },
    isDestroyed: () => false,
  });
  const sent = [];
  const gate = new exports.WindowCloseGate((_owner, id) => sent.push(id), 30);
  const first = gate.request(owner);
  assert.equal(gate.request(owner), first);
  gate.decide({ sender: {}, senderFrame: owner.mainFrame }, { id: sent[0], allowed: true });
  gate.decide({ sender: owner, senderFrame: {} }, { id: sent[0], allowed: true });
  owner.emit("did-start-navigation", {}, "areal-ui://app/", false, true);
  assert.equal(await first, false);
  const second = gate.request(owner);
  gate.decide({ sender: owner, senderFrame: owner.mainFrame }, { id: sent[0], allowed: true });
  gate.decide({ sender: owner, senderFrame: owner.mainFrame }, { id: sent[1], allowed: true });
  assert.equal(await second, true);
  assert.deepEqual(owner.eventNames(), []);
  assert.equal(await gate.request(owner), false, "an unacknowledged window stays open");
  assert.deepEqual(owner.eventNames(), []);
});

test("preload window close rejects detached listeners and ignores their late success", async () => {
  const { EventEmitter } = require("node:events");
  const { runInNewContext } = require("node:vm");
  const ipc = new EventEmitter();
  const replies = [];
  ipc.send = (channel, value) => replies.push({ channel, ...value });
  let bridge;
  runInNewContext(readFileSync(preloadPath, "utf8"), {
    require: (name) => {
      assert.equal(name, "electron");
      return {
        ipcRenderer: ipc,
        contextBridge: {
          exposeInMainWorld(_name, api) {
            bridge = api;
          },
        },
      };
    },
  });
  let complete;
  const stop = bridge.onWindowClosing(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  ipc.emit("areal-core:window-closing", {}, 1);
  await Promise.resolve();
  stop();
  complete(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(replies, [
    { channel: "areal-core:window-close-decision", id: 1, allowed: false },
  ]);
  bridge.onWindowClosing(() => true);
  ipc.emit("areal-core:window-closing", {}, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replies.at(-1), {
    channel: "areal-core:window-close-decision",
    id: 2,
    allowed: true,
  });
});
