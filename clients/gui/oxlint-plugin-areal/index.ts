import { definePlugin } from "@oxlint/plugins";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";
import noRawResizeObserver from "./rules/no-raw-resize-observer.ts";
import noRawDisclosure from "./rules/no-raw-disclosure.ts";
import noNativeTitle from "./rules/no-native-title.ts";
import noTransitionAll from "./rules/no-transition-all.ts";

export default definePlugin({
  meta: { name: "areal" },
  rules: {
    "require-suppression-reason": requireSuppressionReason,
    "no-raw-resize-observer": noRawResizeObserver,
    "no-raw-disclosure": noRawDisclosure,
    "no-native-title": noNativeTitle,
    "no-transition-all": noTransitionAll,
  },
});
