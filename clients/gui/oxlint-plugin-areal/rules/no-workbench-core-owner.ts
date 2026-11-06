import { defineRule, type ESTree } from "@oxlint/plugins";

const CORE_CLIENT = /(?:^|\/)runtime-client\/(?:core|core\.js)$|^@areal\/runtime-client\/core$/;
const CORE_PROCESS = /(?:^|\/)core-process(?:-fixture)?(?:\.cjs|\.js|\.ts)?$/;
const CORE_EXECUTABLE = /(?:^|[/\\])areal(?:-core)?$/;
function unwrap(node: ESTree.Node): ESTree.Node {
  while (
    node.type === "TSAsExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "ChainExpression" ||
    node.type === "ParenthesizedExpression"
  )
    node = node.expression;
  return node;
}
function text(node: ESTree.Node): string | undefined {
  node = unwrap(node);
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}
function property(node: ESTree.MemberExpression): string | undefined {
  return !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : text(node.property);
}

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep Core sockets and Core process ownership in Rust Host/Core." },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    if (
      !filename.includes("/services/workbench/src/") ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename)
    )
      return {};
    const message =
      "Workbench accesses Core through the schema-registered Host core.request. Core sockets and process launch belong to Rust Host/Core.";
    function report(node: ESTree.Node) {
      context.report({ node, message });
    }
    function binding(node: ESTree.Identifier): ESTree.Node | undefined {
      let scope = context.sourceCode.getScope(node);
      while (scope) {
        const variable = scope.set.get(node.name);
        if (variable?.defs.length === 1 && variable.defs[0].node.type === "VariableDeclarator")
          return variable.defs[0].node.init ?? undefined;
        scope = scope.upper!;
      }
      return undefined;
    }
    function coreExecutable(node: ESTree.Node, seen = new Set<ESTree.Node>()): boolean {
      node = unwrap(node);
      if (seen.has(node)) return false;
      seen.add(node);
      const literal = text(node);
      if (literal !== undefined) return CORE_EXECUTABLE.test(literal);
      if (node.type === "Identifier") {
        if (/^(?:binary|coreBinary|coreBin|arealBinary)$/.test(node.name)) return true;
        const initial = binding(node);
        return !!initial && coreExecutable(initial, seen);
      }
      if (node.type === "MemberExpression")
        return /^(?:binary|coreBinary|coreBin|arealBinary|AREAL_CORE_BIN)$/.test(
          property(node) ?? "",
        );
      return false;
    }
    function coreAddress(node: ESTree.Node, seen = new Set<ESTree.Node>()): boolean {
      node = unwrap(node);
      if (seen.has(node)) return false;
      seen.add(node);
      if (node.type === "Identifier") {
        const initial = binding(node);
        return !!initial && coreAddress(initial, seen);
      }
      if (node.type === "MemberExpression")
        return (
          property(node) === "endpoint" &&
          node.object.type === "Identifier" &&
          /^(?:project|entry)$/.test(node.object.name)
        );
      if (
        node.type === "NewExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "URL"
      ) {
        const argument = node.arguments[0];
        return !!argument && argument.type !== "SpreadElement" && coreAddress(argument, seen);
      }
      return false;
    }
    function module(node: ESTree.Node) {
      const source = text(node);
      if (source && (CORE_CLIENT.test(source) || CORE_PROCESS.test(source))) report(node);
    }
    return {
      ImportDeclaration(node) {
        if (
          node.importKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every(
              (specifier) =>
                specifier.type === "ImportSpecifier" && specifier.importKind === "type",
            ))
        )
          return;
        module(node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind !== "type" && node.source) module(node.source);
      },
      ExportAllDeclaration(node) {
        if (node.exportKind !== "type") module(node.source);
      },
      ImportExpression(node) {
        module(node.source);
      },
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee.type === "Identifier" && callee.name === "require" && node.arguments[0])
          module(node.arguments[0]);
        const name =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression"
              ? property(callee)
              : undefined;
        const target = node.arguments[0];
        if (name === "fetch" && target && target.type !== "SpreadElement" && coreAddress(target))
          report(node);
        if (
          !name ||
          !/^(?:spawn|spawnSync|execFile|execFileSync|executeCore|spawnCore)$/.test(name)
        )
          return;
        const executable = node.arguments[0];
        if (executable && executable.type !== "SpreadElement" && coreExecutable(executable)) {
          report(node);
          return;
        }
        // macOS 旧桥接以 Python 为父进程，Core 可执行文件仍藏在 argv 数组中。
        const args = node.arguments[1];
        if (
          args?.type === "ArrayExpression" &&
          args.elements.some(
            (item) => item && item.type !== "SpreadElement" && coreExecutable(item),
          )
        )
          report(node);
      },
      NewExpression(node) {
        const callee = unwrap(node.callee);
        if (callee.type === "Identifier" && callee.name === "CoreClient") {
          report(node);
          return;
        }
        const target = node.arguments[0];
        if (
          callee.type === "Identifier" &&
          callee.name === "WebSocket" &&
          target?.type === "MemberExpression" &&
          property(target) === "endpoint"
        )
          report(node);
      },
    };
  },
});
