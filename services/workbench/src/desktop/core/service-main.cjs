// @ts-check
"use strict";
const { CoreBackend } = require("./backend.cjs");
const { DesktopService } = require("./service-protocol.cjs");
const { serviceIdentity } = require("./service-identity.cjs");
const { resolveDesktopNetwork } = require("./desktop-network.cjs");
const { readLibraryStartupSettings } = require("./library.cjs");
const { SharedPowerMonitor } = require("./power.cjs");
const { join } = require("node:path");

/** 资料库、执行、任务、工作树由 Host 的 Rust 实现负责；工作台只保留其余领域。 */
const RUST_DOMAINS = Object.freeze(["library-rust", "execution-rust", "tasks-rust", "worktree-rust"]);

/** @param {import('./backend.cjs').CoreBackendOptions} options @param {{onClose?:()=>void,hostManaged?:boolean,hostCall?:(call:string,params:unknown)=>Promise<unknown>}} [lifetime] */
async function createMainDesktop(options, { onClose = () => {}, hostManaged = false, hostCall } = {}) {
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
  /** @type {ReturnType<typeof import("../../native-host-transport").createNativeHostTransport>|undefined} */
  let nativeTransport;
  backend.hostCall = hostCall ?? (async (call, params) => {
    const previous = nativeTransport;
    if (previous && (await previous).closed && nativeTransport === previous) nativeTransport = undefined;
    const pending = (nativeTransport ??= require("@areal/workbench-service/native-host-transport").createNativeHostTransport(backend, options));
    return pending.then((transport) => transport.call(call, params).catch((error) => {
      if (transport.closed && nativeTransport === pending) nativeTransport = undefined;
      throw error;
    }), (error) => { if (nativeTransport === pending) nativeTransport = undefined; throw error; });
  });
  backend.rustDomains = hostManaged ? [...RUST_DOMAINS] : [];
  /** @type {InstanceType<typeof DesktopService>|undefined} */ let adapter;
  /** @type {Promise<void>|undefined} */ let closing;
  let closed = false;
  const close = () =>
    (closing ??= (async () => {
      const remoteClosed = adapter?.remote?.close();
      adapter?.close();
      await remoteClosed;
      await backend.disconnect();
      if (nativeTransport) (await nativeTransport).close();
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
    adapter.rustExecution = hostManaged && backend.rustDomains.includes("execution-rust");
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
