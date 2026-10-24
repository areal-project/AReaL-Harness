'use strict';

// 已核对 Electron 44.9.1 lib/browser/api/web-contents.ts 的私有事件契约。
// Keep normal answers on CDP; the retained callback is only for teardown.
const PINNED_ELECTRON = '44.9.1';
function attachAgentDialogPresentation(contents, { ownership, onFault }) {
  const runListeners = contents.listeners('-run-dialog');
  const cancelListeners = contents.listeners('-cancel-dialogs');
  const originalRun = runListeners[0], originalCancel = cancelListeners[0];
  let unavailable = process.versions.electron !== PINNED_ELECTRON
    || runListeners.length !== 1 || originalRun?.length !== 2
    || originalRun?.constructor.name !== 'AsyncFunction'
    || cancelListeners.length !== 1 || originalCancel?.length !== 0
    ? '当前 Electron 对话框契约不可用，不能交给 Agent' : null;
  let disposed = false, humanPending = 0, pending = null;
  const release = () => { pending = null; };
  const fault = message => {
    unavailable ??= message;
    onFault(new Error(unavailable));
  };
  const cancel = () => {
    const callback = pending;
    release(); // Take ownership before callback reentry or CDP Closed.
    if (callback && !contents.isDestroyed()) {
      try { callback(false, ''); }
      catch { fault('浏览对话框取消未确认，请关闭页面'); }
    }
  };
  const installed = () => {
    const run = contents.listeners('-run-dialog'), cancellations = contents.listeners('-cancel-dialogs');
    return run.length === 1 && run[0] === runDialog
      && cancellations.length === 2 && cancellations[0] === originalCancel && cancellations[1] === cancelled;
  };
  function forward(receiver, args) {
    humanPending++;
    let result;
    try { result = Reflect.apply(originalRun, receiver, args); }
    catch (error) { humanPending--; throw error; }
    // Preserve the original receiver, arguments, callback and returned Promise.
    void Promise.resolve(result).then(() => { humanPending--; }, () => { humanPending--; });
    return result;
  }
  function runDialog(...args) {
    const [info, callback] = args;
    const valid = args.length === 2 && info && typeof info === 'object'
      && ['alert', 'confirm', 'prompt'].includes(info.dialogType)
      && typeof info.messageText === 'string' && typeof info.defaultPromptText === 'string'
      && info.frame && typeof info.frame.origin === 'string' && typeof info.frame.url === 'string'
      && typeof callback === 'function';
    const control = ownership().control;
    if (!valid || !installed()) {
      unavailable ??= 'Electron 对话框契约已变化，不能交给 Agent';
      if (control === 'human') return forward(this, args);
      // An unexpected platform contract cannot fall back to native presentation.
      cancel();
      if (typeof callback === 'function' && !contents.isDestroyed()) callback(false, '');
      fault(unavailable);
      return;
    }
    if (disposed) { callback(false, ''); return; }
    if (control === 'human') return forward(this, args);
    if (control !== 'agent') { callback(false, ''); return; }
    // Electron itself rejects prompt(); leave that unsupported behavior intact.
    if (info.dialogType === 'prompt') return forward(this, args);
    if (unavailable || pending) {
      cancel(); callback(false, '');
      fault('浏览对话框归属冲突，请关闭页面');
      return;
    }
    pending = callback;
  }
  function cancelled(...args) {
    // The platform has already cancelled the Chromium callback.
    release();
    if (args.length !== 1 || typeof args[0]?.resetState !== 'boolean')
      fault('Electron 对话框取消契约已变化，不能交给 Agent');
  }
  const closed = (_event, method) => { if (method === 'Page.javascriptDialogClosed') release(); };
  const destroyed = () => { release(); dispose(); };
  function dispose() {
    if (disposed) return;
    disposed = true; cancel();
    // Restore only while our exact listener set is still the owner.
    const restore = !contents.isDestroyed() && installed();
    contents.removeListener('-run-dialog', runDialog);
    contents.removeListener('-cancel-dialogs', cancelled);
    contents.removeListener('destroyed', destroyed);
    contents.debugger.removeListener('message', closed);
    if (restore) contents.on('-run-dialog', originalRun);
  }
  if (!unavailable) {
    contents.removeListener('-run-dialog', originalRun);
    contents.on('-run-dialog', runDialog);
    contents.on('-cancel-dialogs', cancelled);
    contents.on('destroyed', destroyed);
    contents.debugger.on('message', closed);
  }
  return {
    assertClaimable() {
      if (disposed || contents.isDestroyed() || unavailable || !installed())
        throw new Error(unavailable ?? '浏览对话框展示不可用，不能交给 Agent');
      if (humanPending || pending) throw new Error('请先关闭人工对话框，再交给 Agent');
    },
    cancel,
    dispose,
  };
}

module.exports = { attachAgentDialogPresentation };
