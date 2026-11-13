// @ts-check
"use strict";
const { performance } = require("node:perf_hooks");
const { randomUUID } = require("node:crypto");
const { writeSync } = require("node:fs");

const runId = randomUUID();
let nextAttempt = 0;
const outcomes = new Set(["ok", "error", "degraded", "skipped"]);
const errorCodes = new Set([
  "storageLocked",
  "storageMissing",
  "legacyPending",
  "ENOENT",
  "EACCES",
  "EPERM",
  "EADDRINUSE",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "DISCONNECTED",
  "SERVICE_STOPPING",
  "SERVICE_INCOMPATIBLE",
  "STARTUP_CANCELLED",
  -32700,
  -32600,
  -32601,
  -32602,
  -32603,
]);

/** @param {string} scope @param {Record<string,unknown>} [context] */
function startupTrace(scope, context = {}) {
  const started = performance.now();
  /** @type {Record<string,string|number>} */
  const correlation = {};
  if (typeof context.projectId === "string" && /^[a-f0-9]{24}$/.test(context.projectId))
    correlation.projectId = context.projectId;
  for (const key of ["connectionGeneration", "servicePid"]) {
    if (typeof context[key] === "number" && Number.isSafeInteger(context[key]) && context[key] >= 0)
      correlation[key] = context[key];
  }
  if (
    typeof context.coreGeneration === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(context.coreGeneration)
  )
    correlation.coreGeneration = context.coreGeneration;
  const identity = {
    event: "startup",
    pid: process.pid,
    runId,
    attempt: ++nextAttempt,
    scope,
    ...correlation,
  };
  /** @type {string|undefined} */
  let stage;
  let changed = started,
    finished = false;
  /** @param {number} value */
  const milliseconds = (value) => Math.round(value * 1000) / 1000;
  /** @param {"advance"|"finish"} kind @param {string} outcome @param {string} [nextStage] @param {unknown} [error] */
  function record(kind, outcome, nextStage, error) {
    if (finished) return;
    const now = performance.now();
    const previous =
      stage === undefined ? undefined : { stage, durationMs: milliseconds(now - changed), outcome };
    if (kind === "finish") finished = true;
    else {
      stage = nextStage;
      changed = now;
    }
    try {
      /** @type {Record<string,unknown>} */
      const entry = {
        ...identity,
        at: new Date().toISOString(),
        kind,
        elapsedMs: milliseconds(now - started),
        ...(nextStage === undefined ? {} : { stage: nextStage }),
        ...(previous ? { previous } : {}),
        ...(kind === "finish" ? { outcome } : {}),
      };
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (typeof error.code === "string" || typeof error.code === "number") &&
        errorCodes.has(error.code)
      )
        entry.errorCode = error.code;
      writeSync(2, `[startup] ${JSON.stringify(entry)}\n`);
    } catch {}
  }
  return {
    /** @param {string} nextStage @param {string} [previousOutcome] */
    advance(nextStage, previousOutcome = "ok") {
      record("advance", outcomes.has(previousOutcome) ? previousOutcome : "error", nextStage);
    },
    /** @param {string} outcome @param {unknown} [error] */
    finish(outcome, error) {
      record("finish", outcomes.has(outcome) ? outcome : "error", undefined, error);
    },
  };
}

/** @param {string} scope @param {Record<string,unknown>} [context] */
function operationTrace(scope, context = {}) {
  const started = performance.now();
  /** @type {Record<string,unknown>} */
  const identity = { event: "operation", pid: process.pid, runId, scope };
  for (const key of ["requestId", "projectId"]) {
    if (
      typeof context[key] === "string" &&
      (key === "projectId"
        ? /^[a-f0-9]{24}$/
        : /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
      ).test(context[key])
    )
      identity[key] = context[key];
  }
  if (
    typeof context.viewEpoch === "number" &&
    Number.isSafeInteger(context.viewEpoch) &&
    context.viewEpoch >= 0
  )
    identity.viewEpoch = context.viewEpoch;
  let finished = false;
  /** @param {"stage"|"end"} kind @param {string} stage @param {Record<string,unknown>} [fields] */
  const record = (kind, stage, fields = {}) => {
    if (finished) return;
    if (kind === "end") finished = true;
    /** @type {Record<string,unknown>} */
    const entry = {
      ...identity,
      kind,
      stage,
      at: new Date().toISOString(),
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    };
    for (const key of ["connectionGeneration", "pages", "rows"]) {
      if (typeof fields[key] === "number" && Number.isSafeInteger(fields[key]) && fields[key] >= 0)
        entry[key] = fields[key];
    }
    try {
      writeSync(2, `[operation] ${JSON.stringify(entry)}\n`);
    } catch {}
  };
  return {
    /** @param {string} stage @param {Record<string,unknown>} [fields] */
    advance(stage, fields) {
      record("stage", stage, fields);
    },
    /** @param {string} terminal @param {Record<string,unknown>} [fields] */
    finish(terminal, fields) {
      record("end", terminal, fields);
    },
  };
}

module.exports = { startupTrace, operationTrace };
