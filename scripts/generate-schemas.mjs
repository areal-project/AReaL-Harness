// 固定版本协议生成物：只收集本项目验收使用的上游 schema，不改写 wire 字段。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
if (version !== "codex-cli 0.145.0") throw new Error(`Expected codex-cli 0.145.0; got ${version}`);
const temporary = mkdtempSync(join(tmpdir(), "areal-protocol-"));
execFileSync("codex", ["app-server", "generate-json-schema", "--out", temporary]);
const names = [
  "v1/InitializeParams",
  "v1/InitializeResponse",
  ...[
    "ModelListResponse",
    "ThreadStartParams",
    "ThreadStartResponse",
    "ThreadResumeParams",
    "ThreadResumeResponse",
    "ThreadReadParams",
    "ThreadReadResponse",
    "ThreadListParams",
    "ThreadListResponse",
    "TurnStartParams",
    "TurnStartResponse",
    "TurnSteerParams",
    "TurnSteerResponse",
    "TurnInterruptParams",
    "TurnInterruptResponse",
    "ThreadStartedNotification",
    "TurnStartedNotification",
    "TurnCompletedNotification",
    "ItemStartedNotification",
    "ItemCompletedNotification",
    "AgentMessageDeltaNotification",
    "ReasoningTextDeltaNotification",
    "ReasoningSummaryTextDeltaNotification",
  ].map((n) => `v2/${n}`),
];
const target = resolve("schemas/app-server");
mkdirSync(target, { recursive: true });
const definitions = {};
const schemas = Object.fromEntries(
  names.map((name) => {
    const schema = JSON.parse(readFileSync(join(temporary, `${name}.json`)));
    for (const [key, value] of Object.entries(schema.definitions ?? {})) {
      if (definitions[key] && JSON.stringify(definitions[key]) !== JSON.stringify(value))
        throw new Error(`Definition collision: ${key}`);
      definitions[key] = value;
    }
    delete schema.definitions;
    return [name.split("/").at(-1), schema];
  }),
);
writeFileSync(
  join(target, "codex-0.145.0.json"),
  JSON.stringify({ version: "0.145.0", definitions, schemas }, null, 2) + "\n",
);
console.log(`Generated ${names.length} schemas from ${version}`);
