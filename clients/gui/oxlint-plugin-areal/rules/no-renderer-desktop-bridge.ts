import { defineRule, type ESTree, type Variable } from "@oxlint/plugins";

const GUI = "/clients/gui/";
const UI_SOURCE = /^(?:renderer\/|packages\/(?:app|client|remote|remote-client|ui)\/)/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const CONTRACT_ADAPTERS = new Set([
  "renderer/src/desktop-services.ts",
  "renderer/src/desktop-response.ts",
  "renderer/src/host-services.ts",
]);
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self"]);
const PRELOAD_OBJECTS = new Set(["arealDesktop", "arealHost"]);
const PRELOAD_MESSAGE =
  "Use PlatformServices from services.ts. Access preload only in desktop-services.ts.";

function unwrap(node: ESTree.Node): ESTree.Node {
  while (
    node.type === "TSAsExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "ChainExpression" ||
    node.type === "ParenthesizedExpression"
  )
    node = node.expression;
  return node;
}

function text(node: ESTree.Node): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep desktop preload and transport contracts inside the explicit UI platform adapters.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    const guiAt = filename.lastIndexOf(GUI);
    if (guiAt === -1) return {};
    const guiPath = filename.slice(guiAt + GUI.length);
    if (!UI_SOURCE.test(guiPath)) return {};
    const contractAdapter = CONTRACT_ADAPTERS.has(guiPath);
    const preloadAdapter = guiPath === "renderer/src/desktop-services.ts";
    const aliases = new Set<Variable>();
    const testWrites = new WeakSet<ESTree.Node>();

    function variable(node: ESTree.Node, name: string) {
      let scope = context.sourceCode.getScope(node);
      while (scope) {
        const found = scope.set.get(name);
        if (found) return found;
        scope = scope.upper!;
      }
      return undefined;
    }
    function staticText(node: ESTree.Node, seen = new Set<Variable>()): string | undefined {
      node = unwrap(node);
      const value = text(node);
      if (value !== undefined || node.type !== "Identifier") return value;
      const binding = variable(node, node.name);
      if (!binding || seen.has(binding) || binding.defs.length !== 1) return undefined;
      seen.add(binding);
      const definition = binding.defs[0];
      if (
        definition.node.type !== "VariableDeclarator" ||
        !definition.node.init ||
        definition.parent?.type !== "VariableDeclaration" ||
        definition.parent.kind !== "const"
      )
        return undefined;
      return staticText(definition.node.init, seen);
    }
    function globalObject(node: ESTree.Node): boolean {
      node = unwrap(node);
      if (node.type === "Identifier") {
        const binding = variable(node, node.name);
        return (
          (binding !== undefined && aliases.has(binding)) ||
          (GLOBAL_OBJECTS.has(node.name) && !binding?.defs.length)
        );
      }
      return (
        node.type === "MemberExpression" &&
        globalObject(node.object) &&
        GLOBAL_OBJECTS.has(propertyName(node) ?? "")
      );
    }
    function propertyName(node: ESTree.MemberExpression): string | undefined {
      return !node.computed && node.property.type === "Identifier"
        ? node.property.name
        : staticText(node.property);
    }
    function reportContract(node: ESTree.Node | null | undefined) {
      if (!node || contractAdapter) return;
      const source = staticText(node);
      if (!source || !/(?:^|\/)(?:desktop-contract|state-projection)(?:[/.]|$)/.test(source))
        return;
      context.report({
        node,
        message:
          "Use PlatformServices from services.ts. Desktop transport imports belong only in the registered platform adapters.",
      });
    }
    function checkBinding(target: ESTree.Node, source: ESTree.Node) {
      if (!globalObject(source)) return;
      if (target.type === "Identifier") {
        const binding = variable(target, target.name);
        if (binding) aliases.add(binding);
        return;
      }
      if (target.type !== "ObjectPattern") return;
      for (const property of target.properties) {
        if (property.type !== "Property") continue;
        const name =
          !property.computed && property.key.type === "Identifier"
            ? property.key.name
            : staticText(property.key);
        if (name && PRELOAD_OBJECTS.has(name) && !preloadAdapter) {
          context.report({
            node: property,
            message: PRELOAD_MESSAGE,
          });
        }
        if (name && GLOBAL_OBJECTS.has(name) && property.value.type === "Identifier") {
          const binding = variable(property.value, property.value.name);
          if (binding) aliases.add(binding);
        }
      }
    }
    return {
      Identifier(node) {
        if (
          preloadAdapter ||
          !PRELOAD_OBJECTS.has(node.name) ||
          variable(node, node.name)?.defs.length ||
          !context.sourceCode
            .getScope(node)
            .references.some((reference) => reference.identifier === node)
        )
          return;
        context.report({ node, message: PRELOAD_MESSAGE });
      },
      ImportDeclaration(node) {
        reportContract(node.source);
      },
      ExportNamedDeclaration(node) {
        reportContract(node.source);
      },
      ExportAllDeclaration(node) {
        reportContract(node.source);
      },
      ImportExpression(node) {
        reportContract(node.source);
      },
      TSImportType(node) {
        reportContract(node.source);
      },
      TSExternalModuleReference(node) {
        reportContract(node.expression);
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require")
          reportContract(node.arguments[0]);
      },
      VariableDeclarator(node) {
        if (node.init) checkBinding(node.id, node.init);
      },
      AssignmentExpression(node) {
        checkBinding(node.left, node.right);
        if (
          TEST_FILE.test(guiPath) &&
          node.operator === "=" &&
          node.left.type === "MemberExpression"
        )
          testWrites.add(node.left);
      },
      MemberExpression(node) {
        if (preloadAdapter || testWrites.has(node) || !globalObject(node.object)) return;
        if (!PRELOAD_OBJECTS.has(propertyName(node) ?? "")) return;
        context.report({
          node,
          message: PRELOAD_MESSAGE,
        });
      },
    };
  },
});
