import { defineRule } from "@oxlint/plugins";

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require synchronous Playwright waitForFunction predicates." },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        const name =
          !callee.computed && callee.property.type === "Identifier"
            ? callee.property.name
            : callee.property.type === "Literal"
              ? callee.property.value
              : undefined;
        const predicate = node.arguments[0];
        if (
          name !== "waitForFunction" ||
          !predicate ||
          (predicate.type !== "ArrowFunctionExpression" &&
            predicate.type !== "FunctionExpression") ||
          !predicate.async
        )
          return;
        context.report({
          node: predicate,
          message:
            "Playwright treats the Promise as truthy; poll asynchronous reads outside waitForFunction.",
        });
      },
    };
  },
});
