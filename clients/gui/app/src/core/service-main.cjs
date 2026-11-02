// @ts-check
"use strict";
const { CoreBackend } = require("./backend.cjs");
const { DesktopService } = require("./service-protocol.cjs");
const { serviceIdentity } = require("./service-config.cjs");
const { resolveDesktopNetwork } = require("./desktop-network.cjs");
const { readLibraryStartupSettings } = require("./library.cjs");
const { SharedPowerMonitor } = require("./power.cjs");
const { join } = require("node:path");

/** @param {import('./backend.cjs').CoreBackendOptions} options */
async function createMainDesktop(options) {
  const { app, safeStorage } = require("electron");
  await app.whenReady();
  const network = await resolveDesktopNetwork(
    readLibraryStartupSettings(options.home),
    process.env,
    {
      caBundleDirectory: join(options.home, "network-ca"),
    },
  );
  const backend = new CoreBackend({
    ...options,
    sourceSingletonHeld: true,
    proxyEnvironment: network,
    encryption: safeStorage,
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
    })());
  try {
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
