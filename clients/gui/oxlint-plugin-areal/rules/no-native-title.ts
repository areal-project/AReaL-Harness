import { defineRule } from "@oxlint/plugins";

// iframe 的 title 是可访问名称；option 在原生下拉里画不出共享提示。
const NAMED_BY_TITLE = new Set(["iframe", "option"]);

// R-CHECK-021: 悬停提示只走共享 Tooltip，原生 title 没有延迟分组、滚动收起和主题样式。
export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow the native title attribute on DOM elements; use TitleTooltip." },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const tag = node.name.name;
        if (!/^[a-z]/.test(tag) || NAMED_BY_TITLE.has(tag)) return;
        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier")
            continue;
          if (attribute.name.name !== "title") continue;
          context.report({
            node: attribute.name,
            message: `R-CHECK-021: <${tag} title> shows the browser tooltip. Wrap the element in TitleTooltip from @areal/ui, or pass title to Button.`,
          });
        }
      },
    };
  },
});
