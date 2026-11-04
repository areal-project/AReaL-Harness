// @ts-check
"use strict";
const guard = process.argv.find((arg) => arg.startsWith("--areal-relay-legacy-guard="));
if (guard) {
  const { app } = require("electron");
  void require("./core/relay-legacy-guard.cjs")
    .holdLegacyRelayGuard(app, guard.slice("--areal-relay-legacy-guard=".length))
    .catch(() => app.exit(1));
} else {
  require("./core/main.cjs");
}
