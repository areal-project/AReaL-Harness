"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const guiRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(guiRoot, "../..");
const ts = createRequire(path.join(guiRoot, "renderer/package.json"))("typescript");

// 冻结历史遗留的单层循环扇出基线（只允许减少，不允许新增文件/命令或增加计数）。
const HISTORICAL_LOOP_RPC_ALLOWLIST = Object.freeze({
  "clients/gui/renderer/src/AgentsPane.tsx::action:manage": 2,
  "clients/gui/renderer/src/Composer.tsx::action:manage": 1,
  "clients/gui/renderer/src/ComposerSkills.tsx::action:resources": 1,
  "clients/gui/renderer/src/ComposerSkills.tsx::action:manage": 1,
  "clients/gui/renderer/src/ComposerUploads.ts::action:media": 1,
  "clients/gui/renderer/src/ExecutionsPane.tsx::action:manage": 1,
  "clients/gui/renderer/src/ForkHistory.tsx::action:manage": 1,
  "clients/gui/renderer/src/Inbox.tsx::action:manage": 1,
  "clients/gui/renderer/src/McpAppsWorkspace.tsx::action:manage": 1,
  "clients/gui/renderer/src/TaskCenter.tsx::action:manage": 2,
  "clients/gui/renderer/src/TaskCenter.tsx::action:connect": 2,
  "clients/gui/renderer/src/TaskCenter.tsx::action:tasks": 4,
  "clients/gui/renderer/src/TaskRunConversations.tsx::action:open": 1,
  "clients/gui/renderer/src/host-auxiliary-reads.ts::query:attention.read": 1,
  "clients/gui/renderer/src/host-auxiliary-reads.ts::query:project.models": 1,
  "clients/gui/renderer/src/host-auxiliary-reads.ts::workbench:desktop.command": 1,
  "clients/gui/renderer/src/host-pages.ts::workbench:pages.resource": 3,
  "clients/gui/renderer/src/host-pages.ts::workbench:pages.command": 1,
  "clients/gui/renderer/src/settings/PluginSkillsPage.tsx::action:manage": 1,
  "clients/gui/renderer/src/settings/PluginSkillsPage.tsx::action:resources": 2,
  "clients/gui/renderer/src/state/useConversationObservation.ts::action:prediction": 1,
  "clients/gui/renderer/src/terminal/coreTerminalService.ts::action:manage": 2,
  "clients/gui/renderer/src/trajectory-inspection.ts::action:manage": 14,
  "clients/gui/renderer/src/workspace-file-tree/WorkspaceFileTree.tsx::action:workspace": 1,
  "clients/gui/app/src/core/mcp-form-resources.cjs::command:manage": 1,
  "clients/gui/app/src/core/service-client.cjs::command:side": 3,
  "services/workbench/src/desktop/core/library.cjs::hostCall:library.patch": 1,
  "services/workbench/src/desktop/core/service-protocol.cjs::command:history": 1,
});

// 冻结历史遗留的嵌套循环扇出基线（严禁任何新增 O(N^2) 嵌套循环请求）。
const HISTORICAL_NESTED_LOOP_ALLOWLIST = Object.freeze({
  "clients/gui/renderer/src/ComposerSkills.tsx::action:manage": 1,
  "clients/gui/renderer/src/TaskCenter.tsx::action:connect": 2,
  "clients/gui/renderer/src/TaskCenter.tsx::action:tasks": 4,
  "clients/gui/renderer/src/host-auxiliary-reads.ts::workbench:desktop.command": 1,
  "clients/gui/renderer/src/host-pages.ts::workbench:pages.resource": 2,
  "clients/gui/renderer/src/state/useConversationObservation.ts::action:prediction": 1,
  "clients/gui/renderer/src/trajectory-inspection.ts::action:manage": 10,
});

// 冻结历史遗留的单次迭代内同命令双发基线（renderer/src 下定时任务已清零，严禁新增 N×2 双发）。
const HISTORICAL_LOOP_DUAL_ALLOWLIST = Object.freeze({
  "clients/gui/renderer/src/terminal/coreTerminalService.ts::action:manage": 2,
  "clients/gui/app/src/core/service-client.cjs::command:side": 2,
});

const ITER_METHODS = new Set(["map", "forEach", "flatMap", "filter", "reduce", "some", "every"]);

function walkProductionFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        ["node_modules", "dist", "vendor", "generated", "design-system", "build"].includes(
          entry.name,
        )
      )
        continue;
      walkProductionFiles(full, out);
    } else if (
      /\.(?:cjs|mjs|js|jsx|ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|spec)\./.test(entry.name)
    ) {
      out.push(path.relative(repoRoot, full).replaceAll("\\", "/"));
    }
  }
  return out;
}

function isLoopNode(node) {
  if (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  ) {
    return true;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    node.parent &&
    ts.isCallExpression(node.parent)
  ) {
    const expr = node.parent.expression;
    if (
      ts.isPropertyAccessExpression(expr) &&
      ITER_METHODS.has(expr.name.text) &&
      node.parent.arguments[0] === node
    ) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(expr) &&
      expr.name.text === "from" &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "Array" &&
      node.parent.arguments[1] === node
    ) {
      return true;
    }
  }
  return false;
}

function isDeferredFunctionBoundary(node) {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return true;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (isLoopNode(node)) return false;
    if (node.parent && ts.isCallExpression(node.parent)) {
      const expr = node.parent.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        ["then", "catch", "finally", "all", "allSettled", "race"].includes(expr.name.text)
      ) {
        return false;
      }
      if (node.parent.expression === node) return false;
    }
    return true;
  }
  return false;
}

function rpcKey(node) {
  if (!ts.isCallExpression(node)) return null;
  const expr = node.expression;
  if (
    ts.isIdentifier(expr) &&
    expr.text === "action" &&
    node.arguments.length >= 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return `action:${node.arguments[0].text}`;
  }
  if (
    ts.isPropertyAccessExpression(expr) &&
    ["command", "query", "workbench", "hostCall"].includes(expr.name.text) &&
    node.arguments.length >= 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return `${expr.name.text}:${node.arguments[0].text}`;
  }
  return null;
}

function collectLocalFunctions(sf) {
  const fns = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      fns.set(node.name.text, node.body);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      fns.set(node.name.text, node.initializer.body);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return fns;
}

function mergeAdd(a, b) {
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, (out.get(k) ?? 0) + v);
  return out;
}

function mergeMax(a, b) {
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, Math.max(out.get(k) ?? 0, v));
  return out;
}

function maxCallsInBody(node, localFns, seenFns = new Set(), isRoot = false) {
  if (!isRoot && (isDeferredFunctionBoundary(node) || isLoopNode(node))) return new Map();
  if (ts.isIfStatement(node)) {
    const cond = maxCallsInBody(node.expression, localFns, seenFns);
    const thenMap = maxCallsInBody(node.thenStatement, localFns, seenFns);
    const elseMap = node.elseStatement
      ? maxCallsInBody(node.elseStatement, localFns, seenFns)
      : new Map();
    return mergeAdd(cond, mergeMax(thenMap, elseMap));
  }
  if (ts.isConditionalExpression(node)) {
    const cond = maxCallsInBody(node.condition, localFns, seenFns);
    const whenTrue = maxCallsInBody(node.whenTrue, localFns, seenFns);
    const whenFalse = maxCallsInBody(node.whenFalse, localFns, seenFns);
    return mergeAdd(cond, mergeMax(whenTrue, whenFalse));
  }
  if (ts.isSwitchStatement(node)) {
    const expr = maxCallsInBody(node.expression, localFns, seenFns);
    let branches = new Map();
    for (const clause of node.caseBlock.clauses) {
      let clauseMap = new Map();
      for (const stmt of clause.statements) {
        clauseMap = mergeAdd(clauseMap, maxCallsInBody(stmt, localFns, seenFns));
      }
      branches = mergeMax(branches, clauseMap);
    }
    return mergeAdd(expr, branches);
  }
  let total = new Map();
  const key = rpcKey(node);
  if (key) total.set(key, 1);
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const fnName = node.expression.text;
    const body = localFns.get(fnName);
    if (body && !seenFns.has(fnName)) {
      const nextSeen = new Set(seenFns);
      nextSeen.add(fnName);
      total = mergeAdd(total, maxCallsInBody(body, localFns, nextSeen, true));
    }
  }
  ts.forEachChild(node, (child) => {
    total = mergeAdd(total, maxCallsInBody(child, localFns, seenFns));
  });
  return total;
}

function analyzeSource(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const localFns = collectLocalFunctions(sf);
  const loopCounts = {};
  const nestedCounts = {};
  const dualCalls = {};

  function visit(node, depth, seenFns = new Set(), isInlinedRoot = false) {
    const baseDepth = !isInlinedRoot && isDeferredFunctionBoundary(node) ? 0 : depth;
    const nextDepth = isLoopNode(node) ? baseDepth + 1 : baseDepth;
    if (seenFns.size === 0 && isLoopNode(node)) {
      const perIteration = maxCallsInBody(node, localFns, new Set(), true);
      for (const [key, count] of perIteration) {
        if (count >= 2) {
          const id = `${file}::${key}`;
          dualCalls[id] = Math.max(dualCalls[id] ?? 0, count);
        }
      }
    }
    const key = rpcKey(node);
    if (key && nextDepth > 0) {
      const id = `${file}::${key}`;
      loopCounts[id] = (loopCounts[id] ?? 0) + 1;
      if (nextDepth >= 2) {
        nestedCounts[id] = (nestedCounts[id] ?? 0) + 1;
      }
    }
    if (nextDepth > 0 && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fnName = node.expression.text;
      const body = localFns.get(fnName);
      if (body && !seenFns.has(fnName)) {
        const nextSeen = new Set(seenFns);
        nextSeen.add(fnName);
        visit(body, nextDepth, nextSeen, true);
      }
    }
    ts.forEachChild(node, (child) => visit(child, nextDepth, seenFns, false));
  }
  visit(sf, 0);
  return { loopCounts, nestedCounts, dualCalls };
}

function verifyAgainstAllowlist(actual, allowlist, category) {
  const violations = [];
  for (const [id, count] of Object.entries(actual)) {
    const allowed = allowlist[id];
    if (allowed === undefined) {
      violations.push(
        `[${category}] 新增未授权的循环扇出请求 ${id} (count=${count})。请改用批量接口或单次读取。`,
      );
    } else if (count > allowed) {
      violations.push(
        `[${category}] 循环扇出请求数量增长 ${id} (current=${count} > baseline=${allowed})。`,
      );
    }
  }
  return violations;
}

test("production sources introduce no new O(N^2) nested-loop RPCs, N*2 loop dual-dispatches, or unbatched loop RPC fanouts", () => {
  const files = [
    ...walkProductionFiles(path.join(repoRoot, "clients/gui/renderer/src")),
    ...walkProductionFiles(path.join(repoRoot, "clients/gui/app/src")),
    ...walkProductionFiles(path.join(repoRoot, "services/workbench/src")),
  ];
  const loopCounts = {};
  const nestedCounts = {};
  const dualCalls = {};
  for (const file of files) {
    const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const report = analyzeSource(file, text);
    Object.assign(loopCounts, report.loopCounts);
    Object.assign(nestedCounts, report.nestedCounts);
    Object.assign(dualCalls, report.dualCalls);
  }
  const violations = [
    ...verifyAgainstAllowlist(dualCalls, HISTORICAL_LOOP_DUAL_ALLOWLIST, "N*2_LOOP_DUAL_RPC"),
    ...verifyAgainstAllowlist(
      nestedCounts,
      HISTORICAL_NESTED_LOOP_ALLOWLIST,
      "O(N^2)_NESTED_LOOP_RPC",
    ),
    ...verifyAgainstAllowlist(loopCounts, HISTORICAL_LOOP_RPC_ALLOWLIST, "LOOP_RPC_FANOUT"),
  ];
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("AST fanout analyzer deterministically rejects N*2 dual calls (direct or via helper) and O(N^2) nested loops while allowing mutually exclusive branches", () => {
  const directDual = analyzeSource(
    "clients/gui/renderer/src/FutureFeature.tsx",
    `
    export async function loadAll(owners, action) {
      for (const owner of owners) {
        void action("tasks", { operation: "preview", projectId: owner.id });
        await action("tasks", { operation: "observe", projectId: owner.id });
      }
    }
    `,
  );
  assert.equal(
    directDual.dualCalls["clients/gui/renderer/src/FutureFeature.tsx::action:tasks"],
    2,
    "direct preview+observe in loop body must be caught as N*2 dual call",
  );

  const helperDual = analyzeSource(
    "clients/gui/renderer/src/FutureHelper.tsx",
    `
    const readOwner = async (owner, action) => {
      void action("tasks", { operation: "preview", projectId: owner.id });
      return action("tasks", { operation: "observe", projectId: owner.id });
    };
    export async function loadAll(owners, action) {
      await Promise.all(owners.map((owner) => readOwner(owner, action)));
    }
    `,
  );
  assert.equal(
    helperDual.dualCalls["clients/gui/renderer/src/FutureHelper.tsx::action:tasks"],
    2,
    "helper-wrapped preview+observe in .map() must be caught as N*2 dual call",
  );

  const mutuallyExclusive = analyzeSource(
    "clients/gui/renderer/src/FutureSingle.tsx",
    `
    export async function loadAll(owners, explicit, action) {
      for (const owner of owners) {
        const res = explicit
          ? await action("tasks", { operation: "list", projectId: owner.id })
          : await action("tasks", { operation: "observe", projectId: owner.id });
      }
    }
    `,
  );
  assert.equal(
    mutuallyExclusive.dualCalls["clients/gui/renderer/src/FutureSingle.tsx::action:tasks"],
    undefined,
    "mutually exclusive ternary branches execute at most 1 call per iteration",
  );

  const nestedO2 = analyzeSource(
    "clients/gui/renderer/src/FutureQuadratic.tsx",
    `
    const inspectThreads = (project, action) => {
      for (const thread of project.threads) {
        void action("manage", { operation: "inspect", projectId: project.id, threadId: thread.id });
      }
    };
    export function syncAll(projects, action) {
      for (const project of projects) {
        inspectThreads(project, action);
      }
    }
    `,
  );
  assert.equal(
    nestedO2.nestedCounts["clients/gui/renderer/src/FutureQuadratic.tsx::action:manage"],
    1,
    "loop calling a helper that contains a loop must be caught as depth>=2 O(N^2) fanout",
  );
});
