import { defineRule } from "@oxlint/plugins";

const RAW_ELEMENTS = new Set(["details", "summary"]);

// R-CHECK-019: 折叠只走 @areal/ui 的共享组件，宿主不再写原生 details 或直接接 Base UI Collapsible。
export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow native details/summary and direct Base UI Collapsible outside shared disclosure components.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || !RAW_ELEMENTS.has(node.name.name)) return;
        context.report({
          node: node.name,
          message: `R-CHECK-019: <${node.name.name}> draws a left triangle. Use SettingsDisclosure for advanced settings, CollapsibleText for long content, Disclosure for conversation process, or show the list/detail entry directly.`,
        });
      },
      ImportDeclaration(node) {
        if (node.source.value !== "@base-ui/react/collapsible") return;
        context.report({
          node: node.source,
          message:
            "R-CHECK-019: Import Disclosure or SettingsDisclosure from @areal/ui instead of composing Base UI Collapsible in the host.",
        });
      },
    };
  },
});
