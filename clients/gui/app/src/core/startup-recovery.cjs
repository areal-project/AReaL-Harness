'use strict';
const { ServiceConnection, waitForServiceExit } = require('./service-client.cjs');
const { PROTOCOL } = require('./service-protocol.cjs');
const { createResourceRecovery, summary } = require('./resource-recovery.cjs');

// 只使用旧服务的资源恢复/安全停止接口，不将其任务投影接入新 GUI。
async function recoverStartupService({ metadata, home, notify }) {
  const connection = new ServiceConnection();
  try {
    await connection.connect(metadata);
    await connection.request('hello', { protocol: PROTOCOL, identity: metadata.identity });
    const recoverResources = createResourceRecovery({
      backend: { resources: request => connection.request('resources', request, request.operation !== 'inspect') }, notify,
    });
    let lastError = '';
    while (true) {
      const { service } = await connection.request('snapshot');
      const projects = await connection.request('resources', { operation: 'inspect' });
      const busy = service.busy || service.activeCommands > 0 || service.providerUpdating || service.starting > 0;
      const peers = service.clients > 1;
      const unsafe = projects.some(p => !p.restartSafe);
      const blocked = busy || peers || unsafe;
      const canRecover = !busy && !peers && projects.some(p => p.resources.length);
      const detail = [
        '检测到另一版本或启动配置的后台服务。安全重启后继续打开应用，已有模型配置和历史记录会保留。',
        peers && '请先退出其他连接此后台的 GUI。',
        busy && '后台仍有任务、排队消息或操作，请等待完成后重试。',
        canRecover && '受管终端阻止后台重启。请检查并关闭不再需要的终端，然后重新检查。',
        summary(projects), lastError,
      ].filter(Boolean).join('\n\n');
      const buttons = blocked ? ['稍后处理', '重新检查', ...(canRecover ? ['检查后台资源…'] : [])] : ['稍后处理', '重启后台并继续'];
      const answer = await notify({ type: blocked ? 'warning' : 'question', message: blocked ? '后台暂时无法重启' : '需要重启后台服务', detail, buttons, defaultId: canRecover ? 2 : 1, cancelId: 0, noLink: true });
      if (answer.response === 0) throw Object.assign(new Error('后台连接已暂缓，原后台保持运行。可重新检查并处理后台资源。'), { code: 'STARTUP_CANCELLED' });
      lastError = '';
      if (blocked) {
        if (canRecover && answer.response === 2) await recoverResources();
        continue;
      }
      try {
        // 此控制连接已经 hello，forUpdate 可在服务端挡住竞态中新连入的其他 GUI。
        await connection.request('stopService', { protocol: PROTOCOL, forUpdate: true }, true);
      } catch (error) {
        if (error.submissionUnknown || error.code === 'DISCONNECTED') throw error;
        lastError = error.message; continue;
      }
      // 等待旧所有者撤回元数据，不删除锁或连接文件，也不向旧任务重放请求。
      await waitForServiceExit(home, metadata);
      return;
    }
  } catch (error) {
    // 服务可能在检查期间已由原 GUI 正常停止，交给启动路径重新发现。
    if (error.code === 'DISCONNECTED' && !error.submissionUnknown) return;
    throw error;
  } finally { connection.close(); }
}
module.exports = { recoverStartupService };
