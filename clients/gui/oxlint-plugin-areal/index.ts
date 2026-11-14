import { definePlugin } from "@oxlint/plugins";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";
import noRawResizeObserver from "./rules/no-raw-resize-observer.ts";
import noRawDisclosure from "./rules/no-raw-disclosure.ts";
import noNativeTitle from "./rules/no-native-title.ts";
import noRendererDesktopBridge from "./rules/no-renderer-desktop-bridge.ts";
import noWorkbenchCoreOwner from "./rules/no-workbench-core-owner.ts";
import noTransitionAll from "./rules/no-transition-all.ts";
import noRestyle from "./rules/no-restyle.ts";
import noSmokeTransportPatch from "./rules/no-smoke-transport-patch.ts";
import noAsyncWaitForFunction from "./rules/no-async-wait-for-function.ts";

import noUncheckedArrayMethod from "./rules/no-unchecked-array-method.ts";

export default definePlugin({
  meta: { name: "areal" },
  rules: {
    "no-unchecked-array-method": noUncheckedArrayMethod,
    "no-workbench-core-owner": noWorkbenchCoreOwner,
    "require-suppression-reason": requireSuppressionReason,
    "no-raw-resize-observer": noRawResizeObserver,
    "no-raw-disclosure": noRawDisclosure,
    "no-native-title": noNativeTitle,
    "no-transition-all": noTransitionAll,
    "no-renderer-desktop-bridge": noRendererDesktopBridge,
    "no-restyle": noRestyle,
    "no-smoke-transport-patch": noSmokeTransportPatch,
    "no-async-wait-for-function": noAsyncWaitForFunction,
  },
});
