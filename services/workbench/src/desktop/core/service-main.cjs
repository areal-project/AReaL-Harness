// @ts-check
"use strict";
const { CoreBackend } = require("./backend.cjs");
const { DesktopService } = require("./service-protocol.cjs");
const { serviceIdentity } = require("./service-identity.cjs");
const { resolveDesktopNetwork } = require("./desktop-network.cjs");
const { readLibraryStartupSettings } = require("./library.cjs");
const { SharedPowerMonitor } = require("./power.cjs");
const { join } = require("node:path");

/** @param {import('./backend.cjs').CoreBackendOptions} options @param {{onClose?:()=>void,hostCall:(call:string,params:unknown)=>Promise<unknown>}} lifetime
 * 工作台只在 Host 监管下运行；资料库、执行、任务、工作树由 Host 负责，这里保留其余领域。 */
async function createMainDesktop(options, { onClose = () => {}, hostCall }) {
  const network = await resolveDesktopNetwork(
    readLibraryStartupSettings(options.home),
    process.env,
    {
      caBundleDirectory: join(options.home, "network-ca"),
    },
  );
  const backend = new CoreBackend({
    ...options,
    sourceSingletonHeld: options.sourceSingletonHeld ?? true,
    proxyEnvironment: network,
    encryption: options.encryption,
  });
  backend.hostCall = hostCall;
  /** @type {InstanceType<typeof DesktopService>|undefined} */ let adapter;
  /** @type {Promise<void>|undefined} */ let closing;
  let closed = false;
  const close = () =>
    (closing ??= (async () => {
      const remoteClosed = adapter?.remote?.close();
      adapter?.close();
      await remoteClosed;
      await backend.disconnect();
      closed = true;
      onClose();
    })());
  try {
    // Host 接管时在任何恢复与后台初始化前绑定单写者，不能等 ready 后才切换。
    await backend.useHostLibrary(true, true);
    await backend.init();
    const power = new SharedPowerMonitor(backend);
    adapter = new DesktopService(
      backend,
      await serviceIdentity(options),
      () => {
        void close().catch((error) => console.error(backend.providers.redact(String(error))));
      },
      undefined,
      power,
    );
    await adapter.startMain();
    power.start();
    return {
      backend,
      adapter,
      close,
      get closed() {
        return closed;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
module.exports = { createMainDesktop };
