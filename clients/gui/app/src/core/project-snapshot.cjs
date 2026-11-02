// @ts-check
"use strict";
const { isAwaitingResponse } = require("./project-state.cjs");
const { isRemoteControl } = require("./submission-recovery.cjs");
const { projectCoreCapabilities } = require("./core-capabilities.cjs");
const { isTaskDraftConfiguration, displayTaskDraftThread } = require("./task-draft.cjs");
/** @param {Pick<InstanceType<typeof import('./backend.cjs').CoreBackend>,'projects'|'cloudConversations'|'binary'|'ownerTasks'|'awaitingResponses'|'providers'|'defaultProfile'|'host'>} backend @param {import('./project-index.cjs').SavedProject} project @param {Set<string>} taskHistoryOwners */
function snapshotProject(backend, project, taskHistoryOwners) {
  const live = backend.projects.get(project.id);
  const snapshot = live?.model.getSnapshot() ?? null;
  // Management conversations remain hidden from chat navigation, but use the
  // same snapshot/message components through a decoded display projection.
  const state =
    snapshot?.threads && live
      ? {
          ...snapshot,
          threads: Object.fromEntries(
            Object.entries(snapshot.threads).map(([id, thread]) => [
              id,
              isTaskDraftConfiguration(live.configurations?.[id] ?? thread.desktop?.configuration)
                ? displayTaskDraftThread(thread, live)
                : thread,
            ]),
          ),
        }
      : snapshot;
  return {
    ...project,
    hasTaskHistory: taskHistoryOwners.has(project.logicalProjectId ?? project.id),
    backend: "areal",
    core: {
      ...projectCoreCapabilities(backend.binary, live?.client?.capabilities),
      instanceId: live?.service?.serviceId ?? null,
      connectionGeneration: live?.connectionGeneration ?? 0,
      taskDirectoryRevision: backend.ownerTasks.revision(project.id),
    },
    scheduling: backend.host.scheduling(project.id),
    state: backend.cloudConversations.mergeSnapshot(
      project.id,
      state && live?.resourceInitializing ? { ...state, connected: false } : state,
    ),
    pending: (live?.pending ?? [])
      .filter((entry) => !isRemoteControl(entry))
      .map((entry) => ({
        ...entry,
        ...(entry.method === "areal/plugin/userConfig/set"
          ? {
              params: {
                id: entry.params.id,
                expectedRevision: entry.params.expectedRevision,
                expectedDigest: entry.params.expectedDigest,
                requestId: entry.params.requestId,
              },
            }
          : {}),
        awaitingResponse: isAwaitingResponse(backend.awaitingResponses, project.id, entry),
      })),
    outcomes: live?.outcomes ?? {},
    models: live ? backend.providers.catalog(live.models ?? [], live) : [],
    profiles: live?.profiles ?? [],
    lastAcceptedModel:
      live && backend.providers.manages(live)
        ? (backend.providers.lastAcceptedModel ?? null)
        : null,
    defaultProfile:
      live && backend.providers.manages(live)
        ? (live.resourceProfile ?? backend.defaultProfile ?? null)
        : null,
    configurations: live?.configurations ?? {},
    summaries: [
      ...(live?.summaries ?? []),
      ...backend.cloudConversations.projection(project.id).summaries,
    ],
    summariesLoaded: live?.summariesLoaded === true,
    observationErrors: live?.observationErrors ?? {},
    refreshErrors: live?.refreshErrors ?? {},
    error: live?.error ?? null,
  };
}
module.exports = { snapshotProject };
