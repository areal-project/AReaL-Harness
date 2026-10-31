import { definePlugin } from "@oxlint/plugins";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";
import noRawResizeObserver from "./rules/no-raw-resize-observer.ts";
import noRawDisclosure from "./rules/no-raw-disclosure.ts";

export default definePlugin({
  meta: { name: "areal" },
  rules: {
    "require-suppression-reason": requireSuppressionReason,
    "no-raw-resize-observer": noRawResizeObserver,
    "no-raw-disclosure": noRawDisclosure,
  },
});
