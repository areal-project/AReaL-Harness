import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { servePlugin } from "../dist/index.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");

test("large text reaches Core below the plugin frame limit", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const lines = createInterface({ input: output })[Symbol.asyncIterator]();
  const serving = servePlugin({
    input,
    output,
    plugin: {
      inject: ["tools"],
      apply(ctx) {
        ctx.tools.register({
          name: "large",
          description: "snapshot fixture",
          parameters: { type: "object" },
          output: { schema: { type: "string" }, render: (_, text) => [{ type: "text", text }] },
          async execute(args) {
            return "字".repeat(args.count);
          },
        });
      },
    },
  });
  try {
    assert.equal(JSON.parse((await lines.next()).value).protocolVersion, 1);
    for (const [count, success] of [
      [7000, true],
      [20000, false],
    ]) {
      input.write(
        JSON.stringify({
          type: "call",
          callId: String(count),
          params: { threadId: "t", tool: "large", arguments: { count } },
        }) + "\n",
      );
      const raw = (await lines.next()).value;
      const response = JSON.parse(raw).response;
      assert.equal(response.success, success);
      assert(Buffer.byteLength(raw) < 128 * 1024);
      if (success) {
        assert(Buffer.byteLength(response.contentItems[0].text) > 16 * 1024);
        assert.equal(response.contentItems[0].text, "字".repeat(count));
      } else assert.match(response.contentItems[0].text, /96 KiB/);
    }
  } finally {
    input.end();
    await serving;
    output.end();
  }
});

async function fixture(t) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../examples/editor.mjs", import.meta.url))],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exit = once(child, "exit");
  let errors = "";
  child.stderr.on("data", (data) => (errors += data));
  t.after(async () => {
    child.kill();
    await exit;
    assert.equal(errors, "");
  });
  let content = 'export const greeting = "Hello";\n';
  const files = [],
    results = new Map();
  let readyResolve;
  const ready = new Promise((resolve) => (readyResolve = resolve));
  const loop = (async () => {
    for await (const line of createInterface({ input: child.stdout })) {
      const message = JSON.parse(line);
      if (message.protocolVersion) {
        readyResolve(message);
        continue;
      }
      if (message.type === "result") {
        results.get(message.callId)(message.response);
        results.delete(message.callId);
        continue;
      }
      assert.equal(message.type, "file");
      files.push(message.command);
      const command = message.command;
      let result, error;
      if (command.path !== "workspace://repo/greeting.ts")
        error = { code: "PERMISSION_DENIED", message: "denied by Core" };
      else if (command.kind === "stat") result = { kind: "file", size: Buffer.byteLength(content) };
      else if (command.kind === "read")
        result = {
          dataBase64: Buffer.from(content).toString("base64"),
          sha256: hash(content),
          size: Buffer.byteLength(content),
          eof: true,
          nextOffset: Buffer.byteLength(content),
        };
      else if (command.kind === "write") {
        if (command.expected.value !== hash(content))
          error = { code: "CONFLICT", message: "stale file version" };
        else {
          content = Buffer.from(command.dataBase64, "base64").toString();
          result = { sha256: hash(content), size: Buffer.byteLength(content) };
        }
      } else assert.fail(`unexpected operation: ${command.kind}`);
      child.stdin.write(
        JSON.stringify({
          type: "fileResult",
          callId: message.callId,
          requestId: message.requestId,
          result,
          error,
        }) + "\n",
      );
    }
  })();
  t.after(() => loop);
  const info = await ready;
  return {
    info,
    files,
    get text() {
      return content;
    },
    set text(value) {
      content = value;
    },
    call(args, threadId = "thread-a") {
      const callId = randomUUID();
      const result = new Promise((resolve) => results.set(callId, resolve));
      child.stdin.write(
        JSON.stringify({
          type: "call",
          callId,
          params: {
            threadId,
            turnId: randomUUID(),
            tool: "str_replace_editor",
            arguments: { path: "/repo/greeting.ts", ...args },
          },
        }) + "\n",
      );
      return result;
    },
  };
}

test(
  "real DSH editor: declared command subset, view, UTF-8 replace and observed version",
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t);
    assert.deepEqual(host.info.tools[0].inputSchema.properties.command.enum, [
      "view",
      "str_replace",
    ]);
    assert.equal(
      (await host.call({ command: "str_replace", old_str: "Hello", new_str: "你好" })).success,
      false,
    );
    assert.equal(host.files.length, 0, "unobserved edit must not read or write");
    const view = await host.call({ command: "view" });
    assert.equal(view.success, true);
    assert.match(view.structuredContent, /Hello/);
    const changed = await host.call({ command: "str_replace", old_str: "Hello", new_str: "你好" });
    assert.equal(changed.success, true);
    assert.equal(host.text, 'export const greeting = "你好";\n');
    assert.equal(host.files.filter((c) => c.kind === "write").length, 1);
    assert.equal(host.files.at(-1).expected.value, hash('export const greeting = "Hello";\n'));
  },
);

test(
  "session isolation, stale writes, ambiguous edits, unsupported commands and paths",
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t);
    await host.call({ command: "view" });
    assert.equal(
      (await host.call({ command: "str_replace", old_str: "Hello", new_str: "B" }, "thread-b"))
        .success,
      false,
    );
    host.text += "// concurrent edit\n";
    const stale = await host.call({ command: "str_replace", old_str: "Hello", new_str: "A" });
    assert.equal(stale.success, false);
    assert.match(stale.contentItems[0].text, /stale/);
    assert.match(host.text, /Hello/);
    host.text = "Hello Hello\n";
    await host.call({ command: "view" });
    assert.equal(
      (await host.call({ command: "str_replace", old_str: "Hello", new_str: "X" })).success,
      false,
    );
    assert.equal(host.text, "Hello Hello\n");
    const count = host.files.length;
    for (const args of [
      { command: "create" },
      { command: "insert" },
      { command: "view", path: "/etc/passwd" },
      { command: "view", path: "/repo/../secret" },
    ]) {
      assert.equal((await host.call(args)).success, false);
    }
    assert.equal(host.files.length, count);
  },
);

test("reject unsupported services and replacement of platform services", async () => {
  for (const plugin of [
    { inject: ["session"], apply() {} },
    {
      inject: ["tools"],
      apply(ctx) {
        ctx.fs = {};
      },
    },
    {
      inject: ["tools"],
      apply(ctx) {
        ctx.get("subprocess");
      },
    },
  ])
    await assert.rejects(
      servePlugin({ plugin, input: new PassThrough(), output: new PassThrough() }),
      /Unsupported plugin capability/,
    );
});

test(
  "late asynchronous work cannot borrow the next call identity",
  { timeout: 10000 },
  async () => {
    const input = new PassThrough(),
      output = new PassThrough();
    const lines = createInterface({ input: output })[Symbol.asyncIterator]();
    let release, stale;
    const gate = new Promise((resolve) => (release = resolve));
    const serving = servePlugin({
      input,
      output,
      plugin: {
        inject: ["tools", "fs"],
        apply(ctx) {
          ctx.tools.register({
            name: "late",
            description: "Call identity test",
            parameters: { type: "object" },
            output: { schema: { type: "string" }, render: (_, text) => [{ type: "text", text }] },
            async execute(args) {
              if (args.first) {
                stale = gate
                  .then(() => ctx.fs.resolve("/repo/file"))
                  .then(
                    () => "borrowed identity",
                    (error) => error.message,
                  );
                return "scheduled";
              }
              release();
              return stale;
            },
          });
        },
      },
    });
    try {
      assert.equal(JSON.parse((await lines.next()).value).protocolVersion, 1);
      const invoke = async (callId, args) => {
        input.write(
          JSON.stringify({
            type: "call",
            callId,
            params: { threadId: callId, tool: "late", arguments: args },
          }) + "\n",
        );
        const response = JSON.parse((await lines.next()).value);
        assert.equal(response.type, "result");
        return response.response.structuredContent;
      };
      assert.equal(await invoke("first", { first: true }), "scheduled");
      assert.equal(await invoke("second", {}), "no active plugin call");
    } finally {
      input.end();
      await serving;
      output.end();
    }
  },
);
