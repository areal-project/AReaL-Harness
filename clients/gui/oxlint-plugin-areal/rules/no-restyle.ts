import { defineRule } from "@oxlint/plugins";

// 只允许由父级决定的布局类；颜色、字号、间距、圆角、阴影等外观由组件的 variant/size 决定。
const LAYOUT =
  /^-?(?:m[trblxyse]?-|w-|h-|size-|min-[wh]-|max-[wh]-|flex|grow|shrink|basis-|order-|self-|justify-self-|place-self-|col-|row-|grid-(?:cols|rows)-|gap-|space-[xy]-|overflow|inset|top-|left-|right-|bottom-|start-|end-|z-|aspect-)|^(?:absolute|relative|fixed|sticky|static|hidden|block|inline|inline-block|inline-flex|contents|isolate|sr-only)$/;
const EXEMPT_MODULES = new Set(["@areal/ui/icons", "@areal/ui/observe-resize", "@areal/ui/theme"]);

const isLayout = (token: string) => LAYOUT.test(token.replace(/^!/, "").split(":").at(-1) ?? "");

type Node = { type: string; [key: string]: any };

// 收集 className 表达式里的字面量；遇到变量等无法静态判断的部分返回 null。
function literals(node: Node | null | undefined): string[] | null {
  if (!node) return [];
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? [node.value] : [];
    case "JSXExpressionContainer":
      return literals(node.expression);
    case "TemplateLiteral": {
      const parts = node.expressions.map(literals);
      if (parts.some((part: string[] | null) => part === null)) return null;
      return [...node.quasis.map((quasi: Node) => quasi.value.cooked ?? ""), ...parts.flat()];
    }
    case "ConditionalExpression": {
      const a = literals(node.consequent);
      const b = literals(node.alternate);
      return a && b ? [...a, ...b] : null;
    }
    case "LogicalExpression":
      return literals(node.right);
    case "CallExpression": {
      const parts = node.arguments.map(literals);
      return parts.some((part: string[] | null) => part === null) ? null : parts.flat();
    }
    case "ArrayExpression": {
      const parts = node.elements.map(literals);
      return parts.some((part: string[] | null) => part === null) ? null : parts.flat();
    }
    case "ObjectExpression": {
      const keys = node.properties.map((property: Node) =>
        property.type === "Property" && property.key.type === "Literal"
          ? [String(property.key.value)]
          : property.type === "Property" && property.key.type === "Identifier"
            ? [property.key.name]
            : null,
      );
      return keys.some((key: string[] | null) => key === null) ? null : keys.flat();
    }
    default:
      return null;
  }
}

// R-CHECK-022: @areal/ui 组件自己拥有外观；页面只给布局，外观差异做成组件的 variant 或 slot。
export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow restyling @areal/ui components with className or style." },
  },
  create(context) {
    const owned = new Set<string>();
    return {
      ImportDeclaration(node) {
        const source = String(node.source.value);
        if (!source.startsWith("@areal/ui") || EXEMPT_MODULES.has(source)) return;
        if (node.importKind === "type") return;
        for (const specifier of node.specifiers) owned.add(specifier.local.name);
      },
      JSXOpeningElement(node) {
        let name = node.name;
        while (name.type === "JSXMemberExpression") name = name.object;
        if (name.type !== "JSXIdentifier" || !owned.has(name.name)) return;
        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier")
            continue;
          if (attribute.name.name === "style") {
            context.report({
              node: attribute,
              message: `R-CHECK-022: <${name.name}> style restyles a shared component. Lay out with a wrapper or add a variant to @areal/ui.`,
            });
            continue;
          }
          if (attribute.name.name !== "className") continue;
          const values = literals(attribute.value as Node);
          const tokens = values?.flatMap((value) => value.split(/\s+/)).filter(Boolean);
          const bad = tokens?.filter((token) => !isLayout(token));
          if (values === null || bad?.length)
            context.report({
              node: attribute,
              message: `R-CHECK-022: <${name.name}> className may only carry layout classes${bad?.length ? ` (found ${bad.join(" ")})` : " (dynamic value)"}. Pick a variant/size, or add one to @areal/ui.`,
            });
        }
      },
    };
  },
});
