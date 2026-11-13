import { defineRule, type ESTree } from "@oxlint/plugins";

function property(node: ESTree.MemberExpression): string | undefined {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.property.type === "Literal" && typeof node.property.value === "string")
    return node.property.value;
}

function transportPrototype(node: ESTree.Node): boolean {
  return (
    node.type === "MemberExpression" &&
    property(node) === "prototype" &&
    node.object.type === "Identifier" &&
    (node.object.name === "ServiceConnection" || node.object.name === "WebSocket")
  );
}

function transportMember(node: ESTree.Node): boolean {
  return node.type === "MemberExpression" && transportPrototype(node.object);
}

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep migrated smoke interception on the Host barrier." },
  },
  create(context) {
    const report = (node: ESTree.Node) =>
      context.report({
        node,
        message: "Use the shared Host transport barrier instead of patching transport internals.",
      });
    return {
      AssignmentExpression(node) {
        if (transportMember(node.left)) report(node.left);
      },
      UnaryExpression(node) {
        if (node.operator === "delete" && transportMember(node.argument)) report(node.argument);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (
          property(callee) === "defineProperty" &&
          callee.object.type === "Identifier" &&
          callee.object.name === "Object" &&
          node.arguments[0] &&
          transportPrototype(node.arguments[0])
        )
          report(node);
        if (
          property(callee) === "require" &&
          callee.object.type === "MemberExpression" &&
          property(callee.object) === "mainModule" &&
          callee.object.object.type === "Identifier" &&
          callee.object.object.name === "process"
        )
          report(node);
      },
    };
  },
});
