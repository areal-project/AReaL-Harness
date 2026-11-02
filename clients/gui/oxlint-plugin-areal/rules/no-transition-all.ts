import { defineRule, type ESTree } from "@oxlint/plugins";

const TRANSITION_ALL = /(?:^|[\s:"'`])transition-all(?=$|[\s"'`])/;

// R-CHECK-021: transition-all 会把布局、尺寸和滚动条变化也做成动画；只列出要过渡的属性。
export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow the Tailwind transition-all utility." },
  },
  create(context) {
    const check = (node: ESTree.Node, text: string) => {
      if (!TRANSITION_ALL.test(text)) return;
      context.report({
        node,
        message:
          "R-CHECK-021: transition-all animates layout and size changes too. Name the properties, for example transition-[color,background-color] or transition-colors.",
      });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
    };
  },
});
