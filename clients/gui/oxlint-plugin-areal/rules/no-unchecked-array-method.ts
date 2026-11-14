import { defineRule, type ESTree, type Variable } from "@oxlint/plugins";

const methods = new Set([
  "map",
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "flatMap",
  "reduce",
  "forEach",
]);

function unwrap(node: ESTree.Node): ESTree.Node {
  while (
    node.type === "ChainExpression" ||
    node.type === "ParenthesizedExpression" ||
    node.type === "TSNonNullExpression"
  )
    node = node.expression;
  return node;
}

function uncheckedType(node: ESTree.Node | undefined): boolean {
  if (!node) return false;
  if (node.type === "TSTypeAnnotation") return uncheckedType(node.typeAnnotation);
  if (node.type === "TSUnionType") return node.types.some(uncheckedType);
  return (
    node.type === "TSAnyKeyword" ||
    (node.type === "TSTypeReference" &&
      node.typeName.type === "Identifier" &&
      node.typeName.name === "Data")
  );
}

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Check explicit Data/any collections before calling array methods." },
  },
  create(context) {
    function variable(node: ESTree.Node, name: string): Variable | undefined {
      let scope = context.sourceCode.getScope(node);
      while (scope) {
        const found = scope.set.get(name);
        if (found) return found;
        scope = scope.upper!;
      }
      return undefined;
    }
    function unchecked(node: ESTree.Node, seen = new Set<Variable>()): boolean {
      node = unwrap(node);
      if (node.type === "TSAsExpression" || node.type === "TSTypeAssertion")
        return uncheckedType(node.typeAnnotation);
      if (node.type === "MemberExpression") return unchecked(node.object, seen);
      if (node.type === "LogicalExpression" && node.operator === "??")
        return unchecked(node.left, seen);
      if (node.type !== "Identifier") return false;
      const binding = variable(node, node.name);
      if (!binding || seen.has(binding) || binding.defs.length !== 1) return false;
      seen.add(binding);
      const def = binding.defs[0];
      const id = def.name;
      if (id.type === "Identifier" && id.typeAnnotation) return uncheckedType(id.typeAnnotation);
      if (
        def.node.type === "VariableDeclarator" &&
        def.node.init &&
        def.parent?.type === "VariableDeclaration" &&
        def.parent.kind === "const"
      )
        return unchecked(def.node.init, seen);
      return false;
    }
    function same(left: ESTree.Node, right: ESTree.Node): boolean {
      left = unwrap(left);
      right = unwrap(right);
      if (left.type === "Identifier" && right.type === "Identifier")
        return (
          variable(left, left.name) === variable(right, right.name) && left.name === right.name
        );
      if (left.type === "MemberExpression" && right.type === "MemberExpression") {
        return (
          context.sourceCode.getText(left.property) ===
            context.sourceCode.getText(right.property) &&
          left.computed === right.computed &&
          same(left.object, right.object)
        );
      }
      return false;
    }
    function arrayGuard(node: ESTree.Node, target: ESTree.Node): boolean {
      node = unwrap(node);
      return (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Array" &&
        !variable(node.callee.object, "Array")?.defs.length &&
        node.callee.property.type === "Identifier" &&
        node.callee.property.name === "isArray" &&
        !!node.arguments[0] &&
        same(node.arguments[0], target)
      );
    }
    function guarded(node: ESTree.Node, target: ESTree.Node): boolean {
      let child = node;
      for (let parent = child.parent; parent; child = parent, parent = parent.parent) {
        if (
          (parent.type === "IfStatement" || parent.type === "ConditionalExpression") &&
          child === parent.consequent &&
          arrayGuard(parent.test, target)
        )
          return true;
        if (
          parent.type === "LogicalExpression" &&
          parent.operator === "&&" &&
          child === parent.right &&
          arrayGuard(parent.left, target)
        )
          return true;
        if (
          parent.type === "ArrowFunctionExpression" ||
          parent.type === "FunctionExpression" ||
          parent.type === "FunctionDeclaration"
        )
          break;
      }
      return false;
    }
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee.type !== "MemberExpression") return;
        const name =
          !callee.computed && callee.property.type === "Identifier"
            ? callee.property.name
            : callee.property.type === "Literal"
              ? callee.property.value
              : undefined;
        if (typeof name !== "string" || !methods.has(name)) return;
        const receiver = unwrap(callee.object);
        if (!unchecked(receiver)) return;
        const target =
          receiver.type === "LogicalExpression" && receiver.operator === "??"
            ? receiver.left
            : receiver;
        if (guarded(node, target)) return;
        context.report({
          node: callee,
          message:
            "Data/any does not guarantee an array; ?? [] and optional chaining only handle nullish values. Validate this collection with Array.isArray or a trusted parser before calling array methods.",
        });
      },
    };
  },
});
