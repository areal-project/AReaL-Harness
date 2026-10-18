import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 此函数由 Playwright 序列化到真正的 Electron Main 中执行，不能引用外层变量。
export async function probeCoreChild({ BrowserWindow, screen }, { binary, userHome, argv = ['config', 'models', 'read'], timeoutMs = 15000 }) {
  const { execFile } = process.getBuiltinModule('node:child_process');
  const { readFile } = process.getBuiltinModule('node:fs/promises');
  const { createHash } = process.getBuiltinModule('node:crypto');
  const startedAt = new Date().toISOString();
  const binarySHA256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  return new Promise(resolve => {
    let exitCode = null, signal = null, timedOut = false;
    const child = execFile(binary, argv, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, HOME: userHome } }, (error, stdout, stderr) => {
      clearTimeout(timer);
      let validConfig = false;
      try { const value = JSON.parse(stdout); validConfig = !!value && typeof value === 'object' && !Array.isArray(value); } catch {}
      const status = !error && exitCode === 0 && validConfig ? 'completed' : 'blocked';
      resolve({ status, startedAt, finishedAt: new Date().toISOString(), binary, binarySHA256, argv,
        parentPid: process.pid, pid: child.pid ?? null, cwd: process.cwd(), home: userHome,
        exitCode, signal, timedOut, errorCode: error?.code ?? null,
        reason: error ? 'child_failed' : validConfig ? null : 'invalid_config_output',
        // 配置正文可能含私密值；仅记录字节数。夹具必须使用隔离的合成配置。
        stdoutBytes: Buffer.byteLength(stdout ?? ''), stderr: (stderr ?? '').slice(0, 2048),
        versions: { node: process.versions.node, electron: process.versions.electron ?? null },
        desktop: { visibleWindows: BrowserWindow.getAllWindows().filter(w => w.isVisible()).length,
          displays: screen.getAllDisplays().length, unlocked: 'unverified' } });
    });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (code, childSignal) => { exitCode = code; signal = childSignal; });
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

export async function checkBrowserStartup(app, { binary, userHome, scratch }) {
  const result = await app.evaluate(probeCoreChild, { binary, userHome });
  await writeFile(join(scratch, 'startup.json'), JSON.stringify(result, null, 2));
  if (result.status !== 'completed') {
    const error = new Error(`Browser startup blocked: ${result.reason}; see ${join(scratch, 'startup.json')}`);
    error.code = 'BROWSER_STARTUP_BLOCKED';
    throw error;
  }
  return result;
}
