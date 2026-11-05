// @ts-check
"use strict";

const { spawn } = require("node:child_process");
const { isAbsolute } = require("node:path");
const { scrubOwnerEnvironment } = require("./application-owner.cjs");
/** @typedef {import('node:child_process').ChildProcessWithoutNullStreams & {killed:boolean,ownerLifetime?:import('node:stream').Duplex|null}} CoreChild */
/** @typedef {Omit<import('node:child_process').SpawnOptions,'stdio'> & {applicationOwner?:import('./application-owner.cjs').ApplicationOwner}} CoreSpawnOptions */
/** @typedef {CoreSpawnOptions & {timeout?:number,maxBuffer?:number,input?:string|Uint8Array,signal?:AbortSignal}} CoreExecutionOptions */
/** @typedef {{stdout:string,stderr:string}} CoreOutput */
/** @typedef {Error & {code?:string|number|null,timedOut?:boolean}} CoreFailure */

// 系统 Python 保留原生 Core 的父进程；不使用 shell，也不改变可信调用方的 argv/env。
const bridge = `import os,signal,subprocess,sys,time
owner=os.getppid()
lifetime=os.environ.get('AREAL_GUI_LIFETIME_FD')
p=subprocess.Popen(sys.argv[1:],pass_fds=(4,) if lifetime=='4' else ())
if lifetime=='4': os.close(4)
def forward(s,f):
    try: p.send_signal(s)
    except ProcessLookupError: pass
for s in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP): signal.signal(s,forward)
try: os.write(3,(str(p.pid)+"\\n").encode())
except BrokenPipeError:
    p.kill(); p.wait(); sys.exit(1)
while p.poll() is None:
    if os.getppid()!=owner:
        p.terminate()
        try: p.wait(timeout=1)
        except subprocess.TimeoutExpired: p.kill(); p.wait()
        break
    time.sleep(0.02)
r=p.wait()
os.write(3,("exit:"+str(r)+"\\n").encode()); os.close(3)
if r<0:
    if -r not in (signal.SIGKILL,signal.SIGSTOP): signal.signal(-r,signal.SIG_DFL)
    os.kill(os.getpid(),-r)
sys.exit(r)
`;

/** @param {string} binary @param {string[]} args @param {CoreSpawnOptions} [options] */
function spawnCore(binary, args, options = {}) {
  if (!isAbsolute(binary) || !Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    throw new TypeError("Core 调用必须使用可信绝对路径和独立参数");
  const { applicationOwner, ...launch } = options;
  const env = scrubOwnerEnvironment(options.env);
  if (applicationOwner) {
    env.AREAL_GUI_OWNER = JSON.stringify(applicationOwner);
    env.AREAL_GUI_LIFETIME_FD = "4";
  }
  /** @type {import('node:child_process').StdioOptions} */
  const stdio = [
    "pipe",
    "pipe",
    "pipe",
    process.platform === "darwin" ? "pipe" : "ignore",
    ...(applicationOwner ? [/** @type {const} */ ("pipe")] : []),
  ];
  if (process.platform !== "darwin") {
    // Fixed pipe entries guarantee the three standard streams despite the extra-FD overload.
    const child = /** @type {CoreChild} */ (spawn(binary, args, { ...launch, env, stdio }));
    if (applicationOwner)
      child.ownerLifetime = /** @type {import('node:stream').Duplex|null} */ (child.stdio[4]);
    return child;
  }
  const child = /** @type {CoreChild} */ (
    spawn("/usr/bin/python3", ["-I", "-S", "-c", bridge, binary, ...args], {
      ...launch,
      env,
      detached: true,
      stdio,
    })
  );
  if (applicationOwner)
    child.ownerLifetime = /** @type {import('node:stream').Duplex|null} */ (child.stdio[4]);
  /** @type {number|undefined} */
  let pid;
  let buffer = "",
    settled = false,
    bridgeExited = false;
  const killBridge = child.kill.bind(child);
  child.kill = (signal = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    if (!child.pid) return false;
    // 握手前也有有界取消：此独立组仅持有本次 CLI，持久服务由 Core setsid 脱离。
    try {
      process.kill(pid ?? -child.pid, signal);
      child.killed = true;
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      throw error;
    }
  };
  // FD3 is a readable pipe in this macOS-only branch.
  /** @type {import('node:stream').Readable} */ (child.stdio[3]).on(
    "data",
    /** @param {Buffer} chunk */ (chunk) => {
      buffer += chunk;
      if (buffer.length > 256) {
        killBridge("SIGTERM");
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!pid && /^[1-9][0-9]*$/.test(line)) {
          pid = Number(line);
          if (!Number.isSafeInteger(pid) || pid <= 1) {
            killBridge("SIGTERM");
            return;
          }
          if (bridgeExited && !settled) cleanupUnsettled();
        } else if (/^exit:-?[0-9]+$/.test(line)) settled = true;
        else killBridge("SIGTERM");
      }
    },
  );
  function cleanupUnsettled() {
    if (settled || !child.pid) return;
    try {
      process.kill(pid ?? -child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
        child.emit("error", error);
    }
  }
  child.once("exit", () => {
    // exit 先于管道关闭；Core 若仍持有输出管道，等待 close 才清理会互相阻塞。
    bridgeExited = true;
    cleanupUnsettled();
  });
  return child;
}

/** @param {string} binary @param {string[]} args @param {CoreExecutionOptions} [options] @returns {Promise<CoreOutput> & {child:CoreChild|undefined}} */
function executeCore(binary, args, options = {}) {
  const { timeout = 0, maxBuffer = 2 * 1024 * 1024, input, signal, ...launch } = options;
  /** @type {CoreChild|undefined} */
  let child;
  /** @type {Promise<CoreOutput>} */
  const result = new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const stdout = [];
    /** @type {Buffer[]} */
    const stderr = [];
    let outputBytes = 0,
      errorBytes = 0;
    /** @type {CoreFailure|undefined} */
    let failure;
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    /** @type {NodeJS.Timeout|undefined} */
    let escalation;
    const spawned = spawnCore(binary, args, launch);
    child = spawned;
    /** @param {CoreFailure} cause */
    const stop = (cause) => {
      if (failure) return;
      failure = cause;
      spawned.kill("SIGTERM");
      // 配置/服务命令拒绝终止时仍必须结算真实 Core，不能仅杀死 Python 父进程。
      escalation = setTimeout(() => spawned.kill("SIGKILL"), 1000);
      escalation.unref();
    };
    const aborted = () =>
      stop(Object.assign(new Error("Core 调用已取消"), { name: "AbortError", code: "ABORT_ERR" }));
    if (timeout > 0)
      timer = setTimeout(
        () => stop(Object.assign(new Error("Core 调用超时"), { timedOut: true })),
        timeout,
      );
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    spawned.stdout.on(
      "data",
      /** @param {Buffer} chunk */ (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > maxBuffer)
          stop(
            Object.assign(new Error("Core stdout 超过上限"), {
              code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            }),
          );
        else stdout.push(chunk);
      },
    );
    spawned.stderr.on(
      "data",
      /** @param {Buffer} chunk */ (chunk) => {
        errorBytes += chunk.length;
        if (errorBytes > maxBuffer)
          stop(
            Object.assign(new Error("Core stderr 超过上限"), {
              code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            }),
          );
        else stderr.push(chunk);
      },
    );
    spawned.once("error", (error) => {
      failure ??= error;
    });
    spawned.stdin.on("error", (error) => {
      if (!("code" in error) || error.code !== "EPIPE") stop(error);
    });
    spawned.stdin.end(input);
    /** @type {Promise<{code:number|null,exitSignal:NodeJS.Signals|null}>} */
    const exited = new Promise((resolveExit) => {
      spawned.once("exit", (code, exitSignal) => resolveExit({ code, exitSignal }));
      spawned.once("error", () =>
        resolveExit({ code: spawned.exitCode, exitSignal: spawned.signalCode }),
      );
    });
    /** @param {import("node:stream").Readable} stream @returns {Promise<void>} */
    const drained = (stream) =>
      new Promise((resolveDrain) => {
        if (stream.readableEnded || stream.destroyed) {
          resolveDrain();
          return;
        }
        stream.once("end", resolveDrain);
        stream.once("close", resolveDrain);
        stream.once("error", resolveDrain);
      });
    // owner 写端独立于短命 CLI，不能等待包含此管道的 child close。
    void Promise.all([exited, drained(spawned.stdout), drained(spawned.stderr)]).then(
      ([{ code, exitSignal }]) => {
        clearTimeout(timer);
        clearTimeout(escalation);
        signal?.removeEventListener("abort", aborted);
        const value = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        };
        if (!failure && (code !== 0 || exitSignal))
          failure = new Error(`Core 进程退出：${exitSignal ?? code}`);
        if (failure)
          reject(
            Object.assign(failure, value, {
              code: failure.code ?? code,
              signal: exitSignal,
              killed: spawned.killed === true,
            }),
          );
        else resolve(value);
      },
    );
  });
  return Object.assign(result, { child });
}

module.exports = { executeCore, spawnCore };
