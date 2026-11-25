// @ts-check
"use strict";

/**
 * @param {Array<{header:{runId:string,role:string},incident:{incidentId?:unknown,failureSeq:number,rotationGap:boolean}|null}>} runs
 */
function buildMonitoringEnvelope(runs) {
  return {
    schemaVersion: 1,
    source: "desktop-diagnostics",
    transport: "local-only",
    data: {
      path: "runs",
      schema: "areal-harness-diagnostics-v1",
      includes: ["header", "events", "incident"],
    },
    incidents: runs
      .filter((run) => run.incident)
      .map((run) => ({
        runId: run.header.runId,
        role: run.header.role,
        incidentId: run.incident?.incidentId,
        failureSeq: run.incident?.failureSeq,
        rotationGap: run.incident?.rotationGap,
      })),
  };
}

module.exports = { buildMonitoringEnvelope };
