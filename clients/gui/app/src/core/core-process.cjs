'use strict';

const { spawn } = require('node:child_process');
const { isAbsolute } = require('node:path');

// 系统 Python 保留原生 Core 的父进程；不使用 shell，也不改变可信调用方的 argv/env。
const bridge = `import os,signal,subprocess,sys,time
owner=os.getppid()
p=subprocess.Popen(sys.argv[1:])
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

function spawnCore(binary, args, options = {}) {
  if (!isAbsolute(binary) || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new TypeError('Core 调用必须使用可信绝对路径和独立参数');
  const stdio = ['pipe', 'pipe', 'pipe'];
  if (process.platform !== 'darwin') return spawn(binary, args, { ...options, stdio });
  const child = spawn('/usr/bin/python3', ['-I', '-S', '-c', bridge, binary, ...args], { ...options, detached: true, stdio: [...stdio, 'pipe'] });
  let pid, buffer = '', settled = false, bridgeExited = false;
  const killBridge = child.kill.bind(child);
  child.kill = (signal = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    if (!child.pid) return false;
    // 握手前也有有界取消：此独立组仅持有本次 CLI，持久服务由 Core setsid 脱离。
    try { process.kill(pid ?? -child.pid, signal); child.killed = true; return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  child.stdio[3].on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 256) { killBridge('SIGTERM'); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!pid && /^[1-9][0-9]*$/.test(line)) {
        pid = Number(line);
        if (!Number.isSafeInteger(pid) || pid <= 1) { killBridge('SIGTERM'); return; }
        if (bridgeExited && !settled) cleanupUnsettled();
      } else if (/^exit:-?[0-9]+$/.test(line)) settled = true;
      else killBridge('SIGTERM');
    }
  });
  function cleanupUnsettled() {
    if (settled || !child.pid) return;
    try { process.kill(pid ?? -child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') child.emit('error', error); }
  }
  child.once('exit', () => {
    // exit 先于管道关闭；Core 若仍持有输出管道，等待 close 才清理会互相阻塞。
    bridgeExited = true;
    cleanupUnsettled();
  });
  return child;
}

function executeCore(binary, args, options = {}) {
  const { timeout = 0, maxBuffer = 2 * 1024 * 1024, input, signal, ...launch } = options;
  let child;
  const result = new Promise((resolve, reject) => {
    const stdout = [], stderr = [];
    let outputBytes = 0, errorBytes = 0, failure, timer, escalation;
    child = spawnCore(binary, args, launch);
    const stop = cause => {
      if (failure) return;
      failure = cause;
      child.kill('SIGTERM');
      // 配置/服务命令拒绝终止时仍必须结算真实 Core，不能仅杀死 Python 父进程。
      escalation = setTimeout(() => child.kill('SIGKILL'), 1000);
      escalation.unref();
    };
    const aborted = () => stop(Object.assign(new Error('Core 调用已取消'), { name: 'AbortError', code: 'ABORT_ERR' }));
    if (timeout > 0) timer = setTimeout(() => stop(Object.assign(new Error('Core 调用超时'), { timedOut: true })), timeout);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > maxBuffer) stop(Object.assign(new Error('Core stdout 超过上限'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
      else stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      errorBytes += chunk.length;
      if (errorBytes > maxBuffer) stop(Object.assign(new Error('Core stderr 超过上限'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
      else stderr.push(chunk);
    });
    child.once('error', error => { failure ??= error; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error); });
    child.stdin.end(input);
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', aborted);
      const value = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (!failure && (code !== 0 || exitSignal)) failure = new Error(`Core 进程退出：${exitSignal ?? code}`);
      if (failure) reject(Object.assign(failure, value, { code: failure.code ?? code, signal: exitSignal, killed: child.killed === true }));
      else resolve(value);
    });
  });
  result.child = child;
  return result;
}

module.exports = { executeCore, spawnCore };
