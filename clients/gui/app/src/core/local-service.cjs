'use strict';

const { execFile } = require('node:child_process');
const { readFile, realpath } = require('node:fs/promises');
const { isAbsolute, resolve } = require('node:path');

// 可信桌面适配器只调用公共 CLI；不持有或终止 Core/Runtime 子进程。
function request(backend, args, environment = backend.hooks.environment()) {
  return new Promise((resolveResult, reject) => {
    execFile(backend.binary, ['service', ...args, '--json'], {
      env: environment, timeout: args[0] === 'status' ? 10_000 : 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Core 服务请求失败：${backend.providers.redact(stderr || error.message).slice(0, 2048)}`));
        return;
      }
      try { resolveResult(JSON.parse(stdout)); }
      catch { reject(new Error('Core 返回了无效的本地服务描述')); }
    });
  });
}

async function connectService(backend, operation, args, environment, project, dataDir) {
  const descriptor = await request(backend, [operation, ...args], environment);
  if (operation === 'status' && ['stopped', 'unavailable', 'stopping'].includes(descriptor?.state)) {
    throw Object.assign(new Error('Core 服务已停止或正在停止，请显式重新连接'), { code: 'CORE_STOPPED' });
  }
  let endpoint;
  try { endpoint = new URL(descriptor?.endpoint); }
  catch { throw Object.assign(new Error('Core 返回了无效的服务地址'), { code: 'CORE_INCOMPATIBLE' }); }
  if (descriptor.protocolVersion !== 1 || descriptor.state !== 'ready'
    || !/^[a-f0-9]{24}$/.test(descriptor.serviceId) || typeof descriptor.generation !== 'string'
    || typeof descriptor.configFingerprint !== 'string'
    || descriptor.workspace !== await realpath(project.root)
    || descriptor.dataDir !== await realpath(dataDir)
    || endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1'
    || endpoint.username || endpoint.password || typeof descriptor.authFile !== 'string' || !isAbsolute(descriptor.authFile)) {
    throw Object.assign(new Error('Core 服务描述与当前工作区不匹配'), { code: 'CORE_INCOMPATIBLE' });
  }
  const auth = JSON.parse(await readFile(resolve(descriptor.authFile), 'utf8'));
  const principal = auth.principals?.find(item => ['observe', 'interact', 'manage']
    .every(permission => item.permissions?.includes(permission)));
  if (typeof principal?.token !== 'string' || !principal.token) throw new Error('Core 未提供桌面身份');
  return { descriptor, token: principal.token };
}

async function stopService(backend, project) {
  if (!project.service) return;
  const result = await request(backend, ['stop', '--instance', project.service.serviceId]);
  if (result.state !== 'stopped') throw new Error('Core 服务停止结果尚未确认');
  project.service = null;
  clearTimeout(project.reconnectTimer);
  project.reconnectTimer = null;
  project.client?.close();
  project.client = null;
  project.model.connection(false);
}

module.exports = { connectService, stopService };
