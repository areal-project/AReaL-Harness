import { definePlugin } from "@oxlint/plugins";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";
import noRawResizeObserver from "./rules/no-raw-resize-observer.ts";
import noRawDisclosure from "./rules/no-raw-disclosure.ts";
import noNativeTitle from "./rules/no-native-title.ts";
import noRendererDesktopBridge from "./rules/no-renderer-desktop-bridge.ts";
import noWorkbenchCoreOwner from "./rules/no-workbench-core-owner.ts";
import noTransitionAll from "./rules/no-transition-all.ts";

export default definePlugin({
  meta: { name: "areal" },
  rules: {
    "no-workbench-core-owner": noWorkbenchCoreOwner,
    "require-suppression-reason": requireSuppressionReason,
    "no-raw-resize-observer": noRawResizeObserver,
    "no-raw-disclosure": noRawDisclosure,
    "no-native-title": noNativeTitle,
    "no-transition-all": noTransitionAll,
    "no-renderer-desktop-bridge": noRendererDesktopBridge,
  },
});
