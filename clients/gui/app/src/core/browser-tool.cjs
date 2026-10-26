// @ts-check
"use strict";

const definition = Object.freeze({
  name: "browser_v1",
  description:
    "Inspect and navigate authorized pages in this desktop thread. Call describe first; page changes require Core approval.",
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string" },
      parameters: { type: "object" },
    },
    required: ["operation", "parameters"],
    additionalProperties: false,
  },
});

/** @param {Record<string, unknown>} parameters */
function validWait(parameters) {
  if (!integer(parameters.timeoutMs) || parameters.timeoutMs < 1 || parameters.timeoutMs > 30000)
    return false;
  const condition = parameters.condition;
  if (condition === undefined) return true;
  if (!record(condition)) return false;
  if (condition.kind === "documentReady")
    return (
      Object.keys(condition).every((key) => ["kind", "state"].includes(key)) &&
      oneOf(["interactive", "complete"], condition.state)
    );
  if (oneOf(["checked", "enabled"], condition.kind))
    return (
      Object.keys(condition).every((key) => ["kind", "ref", "value"].includes(key)) &&
      typeof condition.ref === "string" &&
      /^r[1-9]\d*$/.test(condition.ref) &&
      typeof condition.value === "boolean"
    );
  return (
    condition.kind === "accessibleName" &&
    Object.keys(condition).every((key) => ["kind", "ref", "name"].includes(key)) &&
    typeof condition.ref === "string" &&
    /^r[1-9]\d*$/.test(condition.ref) &&
    typeof condition.name === "string" &&
    condition.name.length >= 1 &&
    condition.name.length <= 256
  );
}
/** @param {import('./preview/tool-contract.cjs').WaitParameters} parameters
 * @returns {{kind:'wait',timeoutMs:number,condition?:import('./preview/tool-contract.cjs').WaitCondition}} */
function waitAction(parameters) {
  return {
    kind: "wait",
    timeoutMs: parameters.timeoutMs,
    ...(parameters.condition === undefined ? {} : { condition: parameters.condition }),
  };
}

/** @param {unknown} value @returns {value is import('./preview/tool-contract.cjs').BrowserToolInput} */
function validToolInput(value) {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !["operation", "parameters"].includes(key)) ||
    !record(value.parameters)
  )
    return false;
  const parameters = value.parameters;
  const keys = Object.keys(parameters);
  if (value.operation === "command") {
    if (
      !keys.every((key) => ["pageId", "command"].includes(key)) ||
      typeof value.parameters.pageId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.parameters.pageId)
    )
      return false;
    try {
      require("@areal/browser-automation").validateBrowserCommand(value.parameters.command);
      return true;
    } catch {
      return false;
    }
  }
  if (oneOf(["navigate", "newPage"], value.operation)) {
    if (
      !keys.every((key) => ["pageId", "url"].includes(key)) ||
      typeof value.parameters.pageId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.parameters.pageId) ||
      typeof value.parameters.url !== "string" ||
      value.parameters.url.length > 2048
    )
      return false;
    try {
      const url = new URL(value.parameters.url);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }
  if (value.operation === "describe") {
    if (keys.length === 0) return true;
    if (
      keys.length !== 1 ||
      keys[0] !== "topic" ||
      typeof value.parameters.topic !== "string" ||
      value.parameters.topic.length > 96
    )
      return false;
    try {
      describeCommands(value.parameters.topic);
      return true;
    } catch {
      return false;
    }
  }
  if (value.operation === "runBatch") {
    if (
      !keys.every((key) => ["pageId", "snapshotId", "steps"].includes(key)) ||
      typeof value.parameters.pageId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.parameters.pageId) ||
      typeof value.parameters.snapshotId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.parameters.snapshotId) ||
      !Array.isArray(value.parameters.steps) ||
      value.parameters.steps.length < 1 ||
      value.parameters.steps.length > 8
    )
      return false;
    if (
      value.parameters.steps.reduce(
        (total, step) =>
          total +
          (record(step) && step.operation === "wait" && typeof step.timeoutMs === "number"
            ? step.timeoutMs
            : 0),
        0,
      ) > 29000
    )
      return false;
    return value.parameters.steps.every((step, index) => {
      if (!record(step)) return false;
      if (step.operation === "wait")
        return (
          Object.keys(step).every((key) => ["operation", "timeoutMs", "condition"].includes(key)) &&
          validWait(step)
        );
      if (
        step.operation !== "act" ||
        Object.keys(step).some((key) => !["operation", "snapshotId", "action"].includes(key)) ||
        step.snapshotId !== parameters.snapshotId ||
        (index > 0 &&
          record(step.action) &&
          oneOf(["clickAt", "drag", "pressAt"], step.action.kind))
      )
        return false;
      return validToolInput({
        operation: "act",
        parameters: { pageId: parameters.pageId, snapshotId: step.snapshotId, action: step.action },
      });
    });
  }
  if (value.operation === "diagnostics")
    return (
      typeof value.parameters.pageId === "string" &&
      /^[0-9a-f-]{36}$/.test(value.parameters.pageId) &&
      keys.every((key) => ["pageId", "kind", "cursor", "limit"].includes(key)) &&
      oneOf(["console", "network"], value.parameters.kind) &&
      (value.parameters.cursor === undefined ||
        (integer(value.parameters.cursor) && value.parameters.cursor >= 0)) &&
      (value.parameters.limit === undefined ||
        (integer(value.parameters.limit) &&
          value.parameters.limit >= 1 &&
          value.parameters.limit <= 200))
    );
  if (
    !oneOf(["observe", "capture", "act", "wait"], value.operation) ||
    typeof value.parameters.pageId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(value.parameters.pageId)
  )
    return false;
  if (value.operation === "wait")
    return (
      keys.every((key) => ["pageId", "timeoutMs", "condition"].includes(key)) &&
      validWait(value.parameters)
    );
  if (value.operation === "act") {
    if (
      !keys.every((key) => ["pageId", "snapshotId", "action"].includes(key)) ||
      typeof value.parameters.snapshotId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.parameters.snapshotId)
    )
      return false;
    const action = value.parameters.action;
    if (!record(action) || typeof action.kind !== "string") return false;
    /** @param {string} key */
    const coordinate = (key) => integer(action[key]) && action[key] >= 0 && action[key] <= 4096;
    const key = () =>
      typeof action.key === "string" &&
      /^(Enter|Tab|Escape|Backspace|Arrow(Up|Down|Left|Right))$/.test(action.key);
    if (action.kind === "clickAt")
      return (
        Object.keys(action).every((key) => ["kind", "x", "y"].includes(key)) &&
        coordinate("x") &&
        coordinate("y")
      );
    if (action.kind === "drag")
      return (
        Object.keys(action).every((key) =>
          ["kind", "fromX", "fromY", "toX", "toY", "steps"].includes(key),
        ) &&
        ["fromX", "fromY", "toX", "toY"].every(coordinate) &&
        integer(action.steps) &&
        action.steps >= 1 &&
        action.steps <= 20
      );
    if (action.kind === "pressAt")
      return (
        Object.keys(action).every((key) => ["kind", "x", "y", "key"].includes(key)) &&
        coordinate("x") &&
        coordinate("y") &&
        key()
      );
    if (action.kind === "scroll")
      return (
        Object.keys(action).every((key) => ["kind", "target", "deltaX", "deltaY"].includes(key)) &&
        action.target === "viewport" &&
        ["deltaX", "deltaY"].every(
          (key) => integer(action[key]) && Math.abs(action[key]) <= 4096,
        ) &&
        (action.deltaX !== 0 || action.deltaY !== 0)
      );
    if (typeof action.ref !== "string" || !/^r[1-9]\d*$/.test(action.ref)) return false;
    if (action.kind === "selectOption")
      return (
        Object.keys(action).every((key) => ["kind", "ref", "value"].includes(key)) &&
        typeof action.value === "string" &&
        action.value.length <= 256
      );
    if (action.kind === "setChecked")
      return (
        Object.keys(action).every((key) => ["kind", "ref", "checked"].includes(key)) &&
        typeof action.checked === "boolean"
      );
    if (oneOf(["click", "hover"], action.kind))
      return Object.keys(action).every((key) => ["kind", "ref"].includes(key));
    if (action.kind === "fill")
      return (
        Object.keys(action).every((key) => ["kind", "ref", "value"].includes(key)) &&
        typeof action.value === "string" &&
        action.value.length <= 4096
      );
    if (action.kind === "press")
      return Object.keys(action).every((key) => ["kind", "ref", "key"].includes(key)) && key();
    return false;
  }
  if (value.operation === "capture")
    return (
      keys.every((key) => ["pageId", "scope"].includes(key)) &&
      value.parameters.scope === "viewport"
    );
  if (!keys.every((key) => ["pageId", "scope", "budget", "rootRef"].includes(key))) return false;
  if (value.parameters.scope !== undefined && value.parameters.scope !== "document") return false;
  if (
    value.parameters.rootRef !== undefined &&
    (typeof value.parameters.rootRef !== "string" || !/^r[1-9]\d*$/.test(value.parameters.rootRef))
  )
    return false;
  const budget = value.parameters.budget;
  return (
    budget === undefined ||
    (record(budget) &&
      Object.keys(budget).every((key) => ["nodes", "textBytes"].includes(key)) &&
      (budget.nodes === undefined ||
        (integer(budget.nodes) && budget.nodes >= 1 && budget.nodes <= 1000)) &&
      (budget.textBytes === undefined ||
        (integer(budget.textBytes) && budget.textBytes >= 256 && budget.textBytes <= 128 * 1024)))
  );
}

/** @param {string | undefined} topic */
function describeCommands(topic) {
  const { commandSchema, ...summary } =
    require("@areal/browser-automation").describeBrowserCommands();
  const methods = commandSchema.oneOf ?? [];
  /** @param {string} name */
  const methodSchema = (name) =>
    methods.find((schema) => {
      if (typeof schema !== "object") return false;
      const method = schema.properties?.method;
      return typeof method === "object" && method.const === name;
    });
  const playwright = methodSchema("playwright");
  const actions = typeof playwright === "object" ? playwright.properties?.action : undefined;
  const variants = typeof actions === "object" ? (actions.oneOf ?? []) : [];
  if (topic === undefined)
    return {
      ...summary,
      schemaGuide:
        'Call describe with {topic:"command.<method>"} for that exact command schema. For Playwright use {topic:"command.playwright.<action>"}, for example command.playwright.locator.',
      playwrightActions: variants.map((schema) => {
        const name = typeof schema === "object" ? schema.properties?.name : undefined;
        return typeof name === "object" ? name.const : undefined;
      }),
    };
  const parts = topic.split(".");
  if (parts[0] !== "command" || parts.length < 2 || parts.length > 3)
    throw new Error("Unknown browser command topic");
  const schema = methodSchema(parts[1]);
  if (typeof schema !== "object") throw new Error("Unknown browser method");
  if (parts.length === 2)
    return {
      topic,
      example: summary.example,
      unsupportedCapabilities: summary.unsupportedCapabilities,
      commandSchema: schema,
    };
  if (parts[1] !== "playwright") throw new Error("Only Playwright has action topics");
  const action = variants.find((item) => {
    const name = typeof item === "object" ? item.properties?.name : undefined;
    return typeof name === "object" && name.const === parts[2];
  });
  if (action === undefined) throw new Error("Unknown Playwright action");
  return {
    topic,
    example: summary.example,
    unsupportedCapabilities: summary.unsupportedCapabilities,
    commandSchema: { ...schema, properties: { ...schema.properties, action } },
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is number} */
function integer(value) {
  return Number.isSafeInteger(value);
}

/** @param {string} code @param {string} message */
function failure(code, message) {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: `${code}: ${message}` }],
    structuredContent: { code, dispatch: "not_sent" },
  };
}

/** @param {unknown} value */
function success(value) {
  return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] };
}

module.exports = {
  definition,
  validToolInput,
  describeCommands,
  waitAction,
  failure,
  success,
  unconfirmed,
};

/** @param {string[]} choices @param {unknown} value @returns {value is string} */
function oneOf(choices, value) {
  return typeof value === "string" && choices.includes(value);
}

/** 保留 UNKNOWN 和批量已确认前缀，让 Core 继续沿原人工核对屏障结算。
 * @param {string} operation @param {unknown} reason @param {Record<string,unknown>} [result]
 */
function unconfirmed(operation, reason, result = {}) {
  const batch = operation === "runBatch";
  return {
    success: false,
    contentItems: [
      {
        type: "inputText",
        text: batch
          ? "outcome_unknown: inspect the confirmed prefix before any new action"
          : "Browser operation result is unconfirmed. Inspect the current page before continuing; do not replay the operation.",
      },
    ],
    structuredContent: {
      code: "outcome_unknown",
      dispatch: "unknown",
      ...(batch
        ? {
            receipts: result.receipts ?? [],
            failedStep: result.failedStep,
            remaining: "not_sent",
            remainingSteps: result.remainingSteps,
          }
        : { operation, reason: typeof reason === "string" ? reason : "action_unconfirmed" }),
    },
  };
}
