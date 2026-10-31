import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const outputIndex = args.lastIndexOf("--output");
const outputArg = outputIndex < 0 ? null : args[outputIndex + 1];
const output = resolve(
  outputArg && !outputArg.startsWith("--") ? outputArg : ".scratch/browser-navigation-benchmark",
);
mkdirSync(output, { recursive: true });
const resultPath = resolve(output, "RESULT.json");
writeFileSync(
  resultPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      benchmarkVersion: "browser-navigation-native-v2",
      measurementKind: "native-command",
      runStatus: "blocked",
      cases: [],
      error: { message: "Electron has not started" },
    },
    null,
    2,
  ),
);
let child;
try {
  const valueOptions = new Set(["--output", "--samples", "--warmup", "--site-delay-ms", "--seed"]);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--" || args[index] === "--sensitivity") continue;
    if (!valueOptions.has(args[index])) throw new Error(`unknown option ${args[index]}`);
    if (!args[index + 1] || args[index + 1].startsWith("--"))
      throw new Error(`missing value for ${args[index]}`);
    index++;
  }
  const electron = process.env.ELECTRON_EXECUTABLE || require("electron");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(
    electron,
    [
      fileURLToPath(new URL("./navigation-benchmark.cjs", import.meta.url)),
      ...args,
      "--output",
      output,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env },
  );
  const stdout = [],
    stderr = [];
  child.stdout.on("data", (chunk) => {
    stdout.push(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
    process.stderr.write(chunk);
  });
  const deadline = setTimeout(
    () => {
      child.kill("SIGKILL");
    },
    10 * 60 * 1000,
  );
  const outcome = await new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ code: 1, signal: null, error: error.message }));
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(deadline);
  writeFileSync(resolve(output, "stdout.log"), Buffer.concat(stdout));
  writeFileSync(resolve(output, "stderr.log"), Buffer.concat(stderr));
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  result.launcher = { ...outcome, electronExecutable: electron, argv: args };
  if (outcome.code !== 0 || result.runStatus === "running") {
    result.runStatus = "failed";
    result.error ??= {
      message: outcome.error ?? `Electron exited with ${outcome.code ?? outcome.signal}`,
    };
    for (const sample of result.cases) {
      if (sample.status === "running") {
        sample.status = "failed";
        sample.error ??= { code: "process_interrupted", message: result.error.message };
      }
      if (sample.status === "planned") sample.status = "not_run";
    }
  }
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  process.exitCode = outcome.code === 0 && result.runStatus === "completed" ? 0 : 1;
} catch (error) {
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  result.runStatus = "blocked";
  result.error = { message: error.message, stack: error.stack };
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
