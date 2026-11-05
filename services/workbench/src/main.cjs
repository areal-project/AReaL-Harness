"use strict";
// Host 监督的工作台服务入口。领域按 A3 逐个搬入 domains。
const { serve } = require("./channel.cjs");
const { createBackend } = require("./backend.cjs");
const { UsageAnalytics } = require("./domains/analytics.cjs");

const FLUSH_MS = 30000;
// Host 的请求超时是 30 秒；同步更久时先回进行中的统计，界面轮询读取。
const SYNC_WAIT_MS = 20000;

/** @param {{input: NodeJS.ReadableStream, output: NodeJS.WritableStream, data: string}} options */
async function start({ input, output, data }) {
  /** @type {(call: string, params: unknown) => Promise<any>} */
  let host = () => Promise.reject(new Error("CAPABILITY_UNAVAILABLE"));
  const backend = createBackend({ data, host: (call, params) => host(call, params) });
  const analytics = new UsageAnalytics(backend);
  await analytics.init();
  const flush = setInterval(() => void analytics.flush(), FLUSH_MS);
  flush.unref();
  const client = (/** @type {{principal?: unknown, connection?: unknown}} */ context) =>
    `${String(context.principal)}/${String(context.connection)}`;
  /** @type {Record<string, (params: any, context: any) => Promise<unknown>>} */
  const domains = {
    "analytics.read": async () => analytics.command({ operation: "read" }),
    "analytics.sync": async () => {
      const done = analytics.command({ operation: "sync" });
      done.catch(() => {});
      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let timer;
      const later = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ...analytics.summary(), syncing: true }), SYNC_WAIT_MS);
      });
      try {
        return await Promise.race([done, later]);
      } finally {
        clearTimeout(timer);
      }
    },
    "analytics.activity": async (params, context) => {
      if (typeof params?.focused !== "boolean")
        throw Object.assign(new Error("INVALID_PARAMS"), { code: "INVALID_PARAMS" });
      const idleSeconds = Number.isFinite(params.idleSeconds) ? Math.max(0, params.idleSeconds) : 0;
      analytics.activity(client(context), { focused: params.focused, idleSeconds });
      return null;
    },
    "analytics.import": async (params) => {
      analytics.import(params?.state);
      await analytics.flush();
      return analytics.summary();
    },
  };
  await serve({
    input,
    output,
    domains,
    host: (call) => (host = call),
    onEvent: (frame) => {
      if (frame.event === "core.event" && typeof frame.projectId === "string")
        analytics.observe(frame.projectId, String(frame.method), /** @type {any} */ (frame.params) ?? {});
    },
  });
  clearInterval(flush);
  backend.closing = true;
  await analytics.flush();
}

module.exports = { start };

if (require.main === module) {
  const data = process.env.AREAL_WORKBENCH_DATA;
  if (!data) process.exit(2);
  start({ input: process.stdin, output: process.stdout, data }).then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
