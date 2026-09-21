// 原生 Host v2 只使用公开 JSONL broker；文件和进程句柄由 Core 绑定。
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import Ajv from "ajv/dist/2020.js";
const schemas = JSON.parse(
  await readFile(new URL("../../schemas/native-host-v2.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ strict: false, validateFormats: false });
const validate = Object.fromEntries(
  ["ready", "hostToCore", "coreToHost"].map((k) => [k, ajv.compile(schemas[k])]),
);
function check(kind, value) {
  if (!validate[kind](value))
    throw Error(`Native Host ${kind}: ${JSON.stringify(validate[kind].errors)}`);
}
const pending = new Map();
let sequence = 0;
const send = (value) => {
  check(value.protocolVersion ? "ready" : "hostToCore", value);
  return process.stdout.write(JSON.stringify(value) + "\n");
};
const request = (type, callId, command) =>
  new Promise((resolve, reject) => {
    const requestId = ++sequence;
    pending.set(requestId, { resolve, reject });
    send({ type, callId, requestId, command });
  });
send({
  protocolVersion: 2,
  tools: [
    {
      name: "native_write",
      description: "Write and validate a fixture through managed brokers",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
});
const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  const message = JSON.parse(line);
  check("coreToHost", message);
  if (message.type.endsWith("Result")) {
    const waiter = pending.get(message.requestId);
    pending.delete(message.requestId);
    if (message.error) waiter.reject(Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  if (message.type !== "call") throw Error("invalid Host request");
  const callId = message.callId;
  try {
    await request("file", callId, {
      kind: "write",
      path: "workspace://repo/native.txt",
      dataBase64: Buffer.from("native broker\n").toString("base64"),
      expected: { kind: "absent" },
    });
    const started = await request("process", callId, {
      op: "start",
      argv: ["/bin/sh", "-c", "cat native.txt"],
      cwd: "workspace://repo",
      timeoutMs: 3000,
      tty: false,
    });
    const page = await request("process", callId, {
      op: "read",
      processId: started.processId,
      after: null,
      maxBytes: 8192,
      waitMs: 1000,
    });
    const output = Buffer.concat(
      page.chunks.map((c) => Buffer.from(c.dataBase64, "base64")),
    ).toString();
    if (!output.includes("native broker")) throw Error("managed process did not read file");
    let rejected = false;
    try {
      await request("process", callId, {
        op: "get",
        processId: "foreign:process:00000000-0000-0000-0000-000000000000",
      });
    } catch {
      rejected = true;
    }
    if (!rejected) throw Error("foreign process was accepted");
    send({
      type: "result",
      callId,
      response: { success: true, contentItems: [{ type: "inputText", text: output }] },
    });
  } catch (error) {
    send({
      type: "result",
      callId,
      response: { success: false, contentItems: [{ type: "inputText", text: error.message }] },
    });
  }
});
