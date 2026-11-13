// @ts-check
"use strict";
const { nativeText } = require("@areal/workbench-service/desktop/core/native-i18n.cjs");
/** @typedef {import('@areal/client/node').HostActivity} Activity */
/** @typedef {Pick<InstanceType<typeof import('./service-client.cjs').SharedCoreBackend>,'readHostActivity'|'requestHostStop'>} Backend */
/** @typedef {(options:Electron.MessageBoxOptions)=>Promise<{response:number}>} Notify */

/** @param {Activity|null} activity */
function hostActivityLabel(activity) {
  if (!activity?.complete)
    return activity?.totalActiveTasks
      ? nativeText("host.unknownWithTasks", { count: activity.totalActiveTasks })
      : nativeText("host.unknown");
  if (activity.totalActiveTasks)
    return nativeText("host.tasks", { count: activity.totalActiveTasks });
  const turns = activity.projects.reduce(
    (total, project) => total + (project.state === "observed" ? project.activeTurns : 0),
    0,
  );
  if (turns) return nativeText("host.turns", { count: turns });
  return nativeText(
    activity.projects.every((project) => project.state === "observed" && project.idleAllowed)
      ? "host.idle"
      : "host.active",
  );
}

/** @param {Backend} backend @param {Notify} notify @param {()=>void} [onStopping] */
async function confirmHostStop(backend, notify, onStopping = () => {}) {
  const answer = await notify({
    type: "warning",
    message: nativeText("host.stopQuestion"),
    detail: nativeText("host.stopImpact"),
    buttons: [nativeText("common.cancel"), nativeText("lifecycle.cancelAndStop")],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (answer.response !== 1) return { canceled: true };
  onStopping();
  const result = await backend.requestHostStop({ strategy: "cancel" });
  if (!result.stopped || result.operation.phase !== "completed")
    throw Object.assign(new Error(nativeText("lifecycle.stopIncomplete")), {
      code: "LIFECYCLE_INCOMPLETE",
      operation: result.operation,
    });
  return { stopped: true, operation: result.operation };
}

/** @param {Backend} backend @param {Notify} notify @param {()=>void} [onStopping] */
async function confirmHostQuit(backend, notify, onStopping = () => {}) {
  const activity = await backend.readHostActivity().catch(() => null);
  if (
    activity?.complete &&
    activity.projects.every((project) => project.state === "observed" && project.idleAllowed)
  )
    return { keepBackground: true };
  const answer = await notify({
    type: "question",
    message: nativeText("quit.question"),
    detail: `${hostActivityLabel(activity)}\n\n${nativeText("host.keepImpact")}`,
    buttons: [
      nativeText("host.keepAndQuit"),
      nativeText("host.stopAndQuit"),
      nativeText("common.cancel"),
    ],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (answer.response === 0) return { keepBackground: true };
  if (answer.response !== 1) return { canceled: true };
  return confirmHostStop(backend, notify, onStopping);
}

module.exports = { hostActivityLabel, confirmHostQuit, confirmHostStop };
