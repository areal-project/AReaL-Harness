"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolve, join } = require("node:path");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");
const {
  commandDefinitions,
  validateCommandResponse,
} = require("../packages/workbench/client/desktop-contract.cjs");

const cases = [
  [
    "prepareCreator",
    { projectId: "project" },
    {
      projectId: "project",
      profile: { id: "profile", revision: "1" },
      skill: { id: "skill", revision: "1", name: "Creator", description: "" },
      provenance: { upstream: "source", revision: "1", contentDigest: "a".repeat(64) },
    },
    { projectId: "project" },
  ],
  [
    "continue",
    { projectId: "project", threadId: "thread", expectedTurnId: "turn" },
    { queueRevision: 1, configRevision: 1, queueItemId: null },
    { queueRevision: "1" },
  ],
  [
    "fork",
    {
      projectId: "project",
      sourceThreadId: "source",
      workspaceMode: "sharedCurrent",
      anchor: { turnId: "turn", boundary: "before" },
    },
    { threadId: "thread", requestId: "request" },
    { threadId: "thread" },
  ],
  [
    "configure",
    {
      projectId: "project",
      threadId: "thread",
      model: { providerId: "provider", modelId: "model" },
    },
    {
      projects: [],
      library: {
        projects: {},
        threads: {},
        projectOrder: [],
        sections: [],
        sidebarThreadOrder: [],
        sidebarRevision: 0,
        settings: {},
      },
    },
    { projects: {} },
  ],
  [
    "side",
    { projectId: "project", operation: "close", threadId: "thread", requestId: "request" },
    { threadId: "thread", requestId: "request", accepted: true, cleanupConfirmed: false },
    { threadId: "thread", requestId: "request", accepted: true, cleanupConfirmed: "unknown" },
  ],
  [
    "cloudSession",
    { operation: "stop", projectId: "project", threadId: "thread", turnId: "turn" },
    {},
    null,
  ],
];

test("command response type examples agree with runtime rejection", () => {
  for (const [name, params, valid, invalid] of cases) {
    assert.equal(validateCommandResponse(name, params, valid), undefined, name);
    assert.throws(() => validateCommandResponse(name, params, invalid), undefined, name);
  }
});

test("the contract accepts typed examples and rejects invalid requests and responses without suppressions", () => {
  const rows = cases.flatMap(([name, params, valid, invalid], index) => [
    `const request${index}: CommandParams<'${name}'> = ${JSON.stringify(params)};`,
    `const response${index}: CommandResponse<'${name}', typeof request${index}> = ${JSON.stringify(valid)};`,
    `const invalidResponse${index}: CommandResponse<'${name}', typeof request${index}> = ${JSON.stringify(invalid)};`,
  ]);
  const invalidRequests = [
    `const badCreator: CommandParams<'prepareCreator'> = {projectId:'p',profile:{id:'id',revision:1}};`,
    `const badContinue: CommandParams<'continue'> = {projectId:'p',threadId:'t'};`,
    `const badFork: CommandParams<'fork'> = {projectId:'p',sourceThreadId:'t',workspaceMode:'sharedCurrent',anchor:{turnId:'turn',boundary:'middle'}};`,
    `const badConfigure: CommandParams<'configure'> = {projectId:'p',threadId:'t',model:{providerId:'p',modelId:1}};`,
    `const badSide: CommandParams<'side'> = {projectId:'p',operation:'close',threadId:'t'};`,
  ];
  const directory = mkdtempSync(join(tmpdir(), "areal-command-types-"));
  const filename = join(directory, "fixture.mts");
  const unsupportedResponses = Object.keys(commandDefinitions).map(
    // Cloud stop 的回执允许扩展对象，但和运行时一样拒绝 null。
    (name) =>
      `const unsupported_${name}: CommandResponse<'${name}'> = ${name === "cloudSession" ? "null" : "{opaque:true}"};`,
  );
  const source = `import type { CommandName, CommandParams, CommandResponse } from ${JSON.stringify(resolve("packages/workbench/client/desktop-contract.cjs"))};\n${rows.join("\n")}\n${invalidRequests.join("\n")}\nconst known: CommandName = 'fork';\n${unsupportedResponses.join("\n")}\n`;
  try {
    writeFileSync(filename, source);
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({ extends: resolve("app/tsconfig.json"), include: [], files: [filename] }),
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("renderer/node_modules/@typescript/native/bin/tsc"),
        "--ignoreConfig",
        "-p",
        config,
        "--pretty",
        "false",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const expectedLines = [
      ...cases.map((_, index) => 4 + index * 3),
      ...invalidRequests.map((_, index) => 2 + rows.length + index),
      ...unsupportedResponses.map((_, index) => 3 + rows.length + invalidRequests.length + index),
    ];
    const diagnostics = result.stdout
      .trim()
      .split("\n")
      .filter((line) => !line.startsWith(" "))
      .map((line) => {
        const match = line.match(/fixture\.mts\((\d+),\d+\): error TS\d+:/);
        assert.ok(match, line);
        return Number(match[1]);
      });
    assert.deepEqual(diagnostics, expectedLines, result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("validated preview requests narrow required fields by operation without asserting raw payloads", () => {
  const directory = mkdtempSync(join(tmpdir(), "areal-preview-types-"));
  try {
    const fixture = join(directory, "fixture.mts"),
      config = join(directory, "tsconfig.json");
    writeFileSync(
      fixture,
      `import {validatePreview} from ${JSON.stringify(resolve("packages/workbench/client/desktop-contract.js"))};
let request: unknown = JSON.parse('{}');
validatePreview(request);
if (request.operation === 'selectElement') { const x: number = request.x; const page: string = request.pageId; const capture: string = request.captureId; }
if (request.operation === 'applyStyleTrial') { const trial: string = request.trialId; const property: string = request.property; const value: string = request.value; }
if (request.operation === 'navigate') { const url: string = request.url; }
if (request.operation === 'cancelDownload') { const id: string = request.downloadId; const intent: true = request.userIntent; }
if (request.operation === 'hide' && request.captureId !== undefined) { const project: string = request.projectId; const thread: string = request.threadId; }
`,
    );
    writeFileSync(
      config,
      JSON.stringify({ extends: resolve("app/tsconfig.json"), include: [], files: [fixture] }),
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("renderer/node_modules/@typescript/native/bin/tsc"),
        "--ignoreConfig",
        "-p",
        config,
        "--pretty",
        "false",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the shared preload bridge leaves unvalidated invoke and event responses unknown", () => {
  const directory = mkdtempSync(join(tmpdir(), "areal-preload-types-"));
  try {
    const fixture = join(directory, "fixture.mts"),
      config = join(directory, "tsconfig.json");
    writeFileSync(
      fixture,
      `import type {DesktopBridge} from ${JSON.stringify(resolve("packages/workbench/client/desktop-contract.js"))};
declare const bridge: DesktopBridge;
const opaque: unknown = await bridge.command('send', {});
const unsafe: string = await bridge.command('send', {});
bridge.onProjection(value => { const unchecked: {frame:unknown} = value; });
`,
    );
    writeFileSync(
      config,
      JSON.stringify({ extends: resolve("app/tsconfig.json"), include: [], files: [fixture] }),
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("renderer/node_modules/@typescript/native/bin/tsc"),
        "--ignoreConfig",
        "-p",
        config,
        "--pretty",
        "false",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const lines = result.stdout
      .trim()
      .split("\n")
      .filter((line) => !line.startsWith(" "))
      .map((line) => {
        const match = line.match(/fixture\.mts\((\d+),\d+\): error TS\d+:/);
        assert.ok(match, line);
        return Number(match[1]);
      });
    assert.deepEqual(lines, [4, 5], result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("execution trace reads cross the real desktop request validator as read operations", () => {
  const {
    readCommandInvocation,
    commandSemantics,
  } = require("../packages/workbench/client/desktop-contract.cjs");
  for (const request of [
    { operation: "executionTrace", projectId: "project", threadId: "parent" },
    {
      operation: "executionTraceResult",
      projectId: "project",
      threadId: "parent",
      executionId: "execution",
      workerThreadId: "child",
      uri: "areal://blob/" + "a".repeat(64),
    },
  ]) {
    assert.doesNotThrow(() => readCommandInvocation("manage", request));
    assert.equal(commandSemantics("manage", request).effect, "read");
  }
});
