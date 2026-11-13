// @ts-check
"use strict";
const { ServiceConnection } = require("./service-client.cjs");
const {
  DesktopLifecycle,
  assertLifecycleSupport,
  blockerMessage,
  describe,
} = require("./lifecycle.cjs");
const { nativeText } = require("@areal/workbench-service/desktop/core/native-i18n.cjs");
const { PROTOCOL } = require("@areal/workbench-service/desktop/core/service-protocol.cjs");

/** @param {{metadata:{identity?:unknown},home:string}} options */
async function recoverStartupService({ metadata, home }) {
  const connection = new ServiceConnection();
  try {
    const connected = await connection.connect(metadata);
    await connection.request("hello", { protocol: PROTOCOL, identity: metadata.identity });
    await new DesktopLifecycle({ connection, metadata: connected, home }).observe();
    return { kind: "reconnect-existing" };
  } finally {
    connection.close();
  }
}

/** @param {{backend:InstanceType<typeof import('./service-client.cjs').SharedCoreBackend>,notify?:import('@areal/workbench-service/desktop/core/resource-recovery.cjs').Notify,purpose?:string,forUpdate?:boolean,migration?:unknown}} options */
async function recoverConnectedService({
  backend,
  notify,
  purpose = "stop",
  forUpdate = false,
  migration,
}) {
  const observed = await backend.observeLifecycle(true, {
    purpose: purpose === "quit" && !forUpdate ? "quit" : "manage",
  });
  const kind = purpose === "update" || forUpdate ? "updateDesktop" : "stopDesktop";
  if (!("service" in observed)) return assertLifecycleSupport(undefined, kind);
  assertLifecycleSupport(observed.service, kind);
  if (observed.blockers.length)
    throw Object.assign(new Error(blockerMessage(observed.blockers)), {
      code: "LIFECYCLE_BLOCKED",
    });
  const cancel = !observed.ifIdle;
  const retainedServices =
    purpose === "quit" &&
    (observed.service.remote?.enabled ||
      observed.projects.some((project) =>
        project.tasks?.some((task) => task.mode === "scheduled" && !task.paused),
      ));
  if (purpose === "quit" || cancel) {
    if (!notify)
      throw Object.assign(new Error(nativeText("lifecycle.confirmationRequired")), {
        code: "LIFECYCLE_CONFIRMATION_REQUIRED",
      });
    const answer = await notify(
      purpose === "quit"
        ? {
            type: cancel || retainedServices ? "warning" : "question",
            message: nativeText("quit.question"),
            detail:
              cancel || retainedServices
                ? (observed.projects.some((project) => project.observation === "unavailable")
                    ? nativeText("quit.unavailableWarning")
                    : "") + nativeText("quit.activeDetail")
                : nativeText("quit.backendDetail"),
            buttons: [nativeText("common.cancel"), nativeText("common.quit")],
            defaultId: 1,
            cancelId: 0,
            noLink: true,
          }
        : {
            type: "warning",
            message: nativeText("lifecycle.cancelQuestion"),
            detail:
              (cancel ? nativeText("lifecycle.cancelImpact") : "") +
              nativeText("lifecycle.stopImpact") +
              (observed.service.remote?.enabled
                ? nativeText("lifecycle.mobileConnections", {
                    count: observed.service.remote.connections,
                  })
                : "") +
              "\n" +
              observed.projects
                .map((project) =>
                  [
                    project.root ?? project.projectId,
                    describe([project]),
                    ...(project.activeThreads ?? []).map((turn) =>
                      nativeText("lifecycle.activeThread", { value: turn.threadId }),
                    ),
                    ...(project.goals ?? []).map((goal) =>
                      nativeText("lifecycle.goal", { value: goal.objective ?? goal.threadId }),
                    ),
                    ...(project.tasks ?? []).map((task) =>
                      nativeText("lifecycle.task", { value: task.objective ?? task.id }),
                    ),
                    ...(project.resources ?? []).map((resource) =>
                      nativeText("lifecycle.resource", {
                        value: resource.executable || resource.id,
                      }),
                    ),
                  ]
                    .filter(Boolean)
                    .join("\n"),
                )
                .join("\n\n"),
            buttons: [
              nativeText("common.back"),
              purpose === "update"
                ? nativeText("lifecycle.cancelAndUpdate")
                : nativeText("lifecycle.cancelAndStop"),
            ],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          },
    );
    if (answer.response !== 1) return { kind: "dismissed", canceled: true };
    observed.confirmedImpact = true;
  }
  return backend.stopService(forUpdate, { cancel, observed, kind, migration });
}
module.exports = { recoverStartupService, recoverConnectedService };
