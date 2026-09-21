// macOS 开发二进制由系统 Python 持有父进程，避免 Node 父进程触发 AMFI 拒绝。
// 独立描述符返回真实子 PID；强杀/取消仍作用于被测二进制，不绕过故障路径。
import { spawn } from "node:child_process";
const bridge = `import os,signal,subprocess,sys
p=subprocess.Popen(sys.argv[1:])
os.write(3,(str(p.pid)+"\\n").encode()); os.close(3)
def forward(s,f):
    try: p.send_signal(s)
    except ProcessLookupError: pass
signal.signal(signal.SIGTERM,forward)
signal.signal(signal.SIGINT,forward)
r=p.wait()
if r<0:
    if -r not in (signal.SIGKILL,signal.SIGSTOP): signal.signal(-r,signal.SIG_DFL)
    os.kill(os.getpid(),-r)
sys.exit(r)
`;
export function spawnNative(binary, args, options) {
  if (process.platform !== "darwin") return spawn(binary, args, options);
  const child = spawn("/usr/bin/python3", ["-I", "-S", "-c", bridge, binary, ...args], {
    ...options,
    stdio: [...options.stdio, "pipe"],
  });
  let pid,
    queued,
    buffer = "";
  const kill = child.kill.bind(child);
  child.kill = (signal = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    if (!pid) {
      queued = signal;
      return true;
    }
    try {
      process.kill(pid, signal);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  child.stdio[3].on("data", (chunk) => {
    buffer += chunk;
    if (buffer.includes("\n")) {
      pid = Number(buffer.trim());
      if (!Number.isSafeInteger(pid) || pid <= 1) {
        kill("SIGKILL");
        return;
      }
      if (queued) child.kill(queued);
    }
  });
  return child;
}
