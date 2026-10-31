import assert from "node:assert/strict";
import { createServer } from "node:http";

export const deltaCount = 200;
export const deltaIntervalMs = 75;
export const domRows = 4000;
export const frameCount = 4;
export const fixtureSentinel = "PERFORMANCE_DOM_SENTINEL";
export const streamText = Array.from(
  { length: deltaCount },
  (_, index) => `delta_${String(index).padStart(3, "0")} `,
).join("");
export const heavyMessage = [
  "# Heavy content fixture",
  "```typescript",
  'export const PERFORMANCE_CODE_READY = "first code block";',
  "```",
  "```mermaid",
  "flowchart LR",
  "  A[Fixture start] --> B[PERFORMANCE_DIAGRAM_READY]",
  "```",
].join("\n");

export async function performanceServers() {
  const state = { requests: [], siteRequests: [], failures: [], pageId: null, toolReceipts: [] };
  const site = createServer((request, response) => {
    state.siteRequests.push({ path: request.url, at: Date.now() });
    if (request.url === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const frame = new URL(request.url, "http://fixture.invalid").searchParams.get("frame");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><title>Performance large document</title></head><body>
      <h1>${fixtureSentinel}${frame === null ? "" : ` FRAME_${frame}`}</h1>
      <main>${Array.from({ length: frame === null ? domRows : 300 }, (_, index) => `<section><h2>Row ${index}</h2><p>Fixed document text ${index}</p><button>Action ${index}</button></section>`).join("")}</main>
      ${frame === null ? Array.from({ length: frameCount }, (_, index) => `<iframe title="Performance frame ${index}" src="/?frame=${index}"></iframe>`).join("") : ""}
      </body></html>`);
  });
  const model = createServer((request, response) => {
    void serveModel(request, response).catch((error) => {
      state.failures.push(error.stack ?? String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  async function serveModel(request, response) {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const user = [...body.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "user" &&
          /PERFORMANCE_(STREAM|BROWSER|HEAVY)/.test(JSON.stringify(message.content)),
      );
    const prompt = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
    const auxiliary = body.messages.some(
      (message) =>
        message.role === "system" &&
        /Generate a concise semantic session title|Predict the next user prompt/.test(
          JSON.stringify(message.content),
        ),
    );
    const kind = auxiliary
      ? "auxiliary"
      : prompt?.includes("PERFORMANCE_STREAM")
        ? "stream"
        : prompt?.includes("PERFORMANCE_BROWSER")
          ? "browser"
          : prompt?.includes("PERFORMANCE_HEAVY")
            ? "heavy"
            : "auxiliary";
    const record = { kind, startedAt: Date.now(), deltas: 0, finishedAt: null, success: false };
    state.requests.push(record);
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (kind === "stream") {
      for (let index = 0; index < deltaCount; index++) {
        assert.ok(!response.destroyed, "Core must consume the complete fixture stream");
        send({ content: `delta_${String(index).padStart(3, "0")} ` });
        record.deltas++;
        await new Promise((resolve) => setTimeout(resolve, deltaIntervalMs));
      }
      send({}, "stop");
    } else if (kind === "browser") {
      assert.ok(state.pageId, "Native browser must be claimed before model calls");
      const receipts = body.messages.filter(
        (message) =>
          message.role === "tool" &&
          String(message.tool_call_id ?? "").startsWith("performance-read-"),
      );
      const operations = [
        { operation: "observe", parameters: { pageId: state.pageId } },
        {
          operation: "command",
          parameters: {
            pageId: state.pageId,
            command: {
              method: "playwright",
              action: { name: "locator", selector: "main", operation: "innerText" },
            },
          },
        },
        { operation: "capture", parameters: { pageId: state.pageId } },
      ];
      if (receipts.length) {
        const last = receipts.at(-1);
        if (!state.toolReceipts.some((receipt) => receipt.id === last.tool_call_id)) {
          state.toolReceipts.push({ id: last.tool_call_id, at: Date.now(), content: last.content });
        }
      }
      if (receipts.length < operations.length) {
        const call = operations[receipts.length];
        record.operation = call.operation;
        send({
          tool_calls: [
            {
              index: 0,
              id: `performance-read-${receipts.length}`,
              type: "function",
              function: { name: "browser_v1", arguments: JSON.stringify(call) },
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        send({ content: "PERFORMANCE_BROWSER_COMPLETE" });
        send({}, "stop");
      }
    } else {
      send({ content: kind === "heavy" ? heavyMessage : "Fixture" });
      send({}, "stop");
    }
    response.end("data: [DONE]\n\n");
    record.finishedAt = Date.now();
    record.success = true;
  }
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  return {
    state,
    siteUrl: `http://127.0.0.1:${site.address().port}/`,
    modelUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions`,
    async close() {
      site.closeAllConnections();
      model.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => site.close(resolve)),
        new Promise((resolve) => model.close(resolve)),
      ]);
    },
  };
}

export function installRendererInputProbe() {
  let sequence = 0;
  const keydown = (event) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest('[data-testid="chat-input"]') ||
      event.key.length !== 1
    )
      return;
    const started = performance.now();
    const index = sequence++;
    requestAnimationFrame(() =>
      console.info(
        "AREAL_PERFORMANCE_INPUT " +
          JSON.stringify({
            index,
            started,
            nextFrameMs: performance.now() - started,
            trusted: event.isTrusted,
            focused:
              document.activeElement === event.target ||
              document.activeElement?.contains(event.target),
          }),
      ),
    );
  };
  document.addEventListener("keydown", keydown, true);
  document.addEventListener(
    "areal-performance-input-stop",
    () => document.removeEventListener("keydown", keydown, true),
    { once: true },
  );
}

export function installFirstUseProbe({ id, selector }) {
  const started = performance.now();
  const samples = [];
  const shifts = [];
  const milestones = {};
  const observer = new PerformanceObserver((list) =>
    shifts.push(
      ...list.getEntries().map((entry) => ({
        at: entry.startTime,
        value: entry.value,
        hadRecentInput: entry.hadRecentInput,
      })),
    ),
  );
  observer.observe({ type: "layout-shift" });
  let active = true;
  const sample = () => {
    const element = document.querySelector(selector);
    const bounds = element?.getBoundingClientRect();
    const shadowText = Array.from(element?.querySelectorAll("diffs-container") ?? [])
      .map((node) => node.shadowRoot?.textContent ?? "")
      .join("");
    const readiness =
      id === "message"
        ? {
            code: shadowText.includes("PERFORMANCE_CODE_READY"),
            diagram: Array.from(element?.querySelectorAll("svg") ?? []).some((svg) =>
              svg.textContent.includes("PERFORMANCE_DIAGRAM_READY"),
            ),
          }
        : id === "file" || id === "diff"
          ? { content: shadowText.includes("PERFORMANCE_FILE_READY") }
          : { terminal: !!element?.querySelector(".xterm-screen") };
    for (const [name, ready] of Object.entries(readiness))
      if (ready && milestones[name] === undefined) milestones[name] = performance.now() - started;
    samples.push({
      at: performance.now(),
      x: bounds?.x ?? null,
      y: bounds?.y ?? null,
      width: bounds?.width ?? null,
      height: bounds?.height ?? null,
      statuses: element?.querySelectorAll('[role="status"], [aria-busy="true"]').length ?? 0,
    });
    if (active && samples.length < 1800) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  document.addEventListener(
    `areal-performance-first-use-stop-${id}`,
    () => {
      active = false;
      observer.disconnect();
      console.info(
        "AREAL_PERFORMANCE_FIRST_USE " +
          JSON.stringify({
            id,
            started,
            milestones,
            observationMs: performance.now() - started,
            samples,
            shifts,
            resources: performance
              .getEntriesByType("resource")
              .filter((entry) => entry.startTime >= started)
              .map((entry) => ({
                name: entry.name,
                startTime: entry.startTime,
                duration: entry.duration,
                transferSize: entry.transferSize,
              })),
          }),
      );
    },
    { once: true },
  );
  return started;
}

export function distribution(values) {
  assert.ok(
    values.length > 0 && values.every(Number.isFinite),
    "Measurements must be nonempty finite numbers",
  );
  const sorted = values.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0],
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1],
    max: sorted.at(-1),
    total: values.reduce((sum, value) => sum + value, 0),
  };
}
