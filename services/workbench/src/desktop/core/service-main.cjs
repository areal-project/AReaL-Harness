// @ts-check
"use strict";
const { CoreBackend } = require("./backend.cjs");
const { DesktopService } = require("./service-protocol.cjs");
const { serviceIdentity } = require("./service-identity.cjs");
const { resolveDesktopNetwork } = require("./desktop-network.cjs");
const { readLibraryStartupSettings } = require("./library.cjs");
const { SharedPowerMonitor } = require("./power.cjs");
const { join } = require("node:path");

/** @param {import('./backend.cjs').CoreBackendOptions} options @param {{onClose?:()=>void,hostManaged?:boolean}} [lifetime] */
async function createMainDesktop(options, { onClose = () => {}, hostManaged = false } = {}) {
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
    if (hostManaged) await backend.useHostLibrary(true, true);
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
    adapter.hostManaged = hostManaged;
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
