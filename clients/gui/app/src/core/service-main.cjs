// @ts-check
"use strict";
const { startupTrace } = require("./startup-timing.cjs");
const startupTraceService = startupTrace("service.startup", { servicePid: process.pid });
startupTraceService.advance("imports");
const {
  app,
  safeStorage,
  dialog,
  Notification,
  powerSaveBlocker,
  crashReporter,
} = require("electron");
const diagnostics = require("./diagnostics.cjs");
const childProcess = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { mkdir, realpath, writeFile, rename, readFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { CoreBackend } = require("./backend.cjs");
const { DesktopService, PROTOCOL } = require("./service-protocol.cjs");
const {
  configureUserData,
  serviceHome,
  serviceOptions,
  serviceIdentity,
} = require("./service-config.cjs");
const { ServiceConnection, waitForServiceProcessExit } = require("./service-client.cjs");
const { createResourceRecovery } = require("./resource-recovery.cjs");
const { BackgroundNotifications } = require("./notifications.cjs");
const { SharedPowerMonitor } = require("./power.cjs");
const { resolveDesktopNetwork } = require("./desktop-network.cjs");
const { readLibraryStartupSettings } = require("./library.cjs");
const { proxyRelay } = require("./proxy-relay.cjs");
const { RemoteControl } = require("./remote.cjs");
const { desktopExecutables } = require("./desktop-executables.cjs");
const { desktopError } = require("@areal/workbench/desktop-contract");
const { readServicePacket } = require("./service-state.cjs");
const { readRecoveryService } = require("./resource-observation.cjs");
const { assertLifecycleSupport, targets } = require("./lifecycle.cjs");
const { readLifecycleResponse } = require("./service-control.cjs");
const { record } = require("./service-transport-contract.cjs");
app.setName("AReaL Harness GUI");
const guiUserData = configureUserData(app);
/** @type {InstanceType<typeof CoreBackend>|undefined} */ let backend;
/** @type {InstanceType<typeof DesktopService>|undefined} */ let service;
/** @type {Awaited<ReturnType<InstanceType<typeof DesktopService>['listen']>>|undefined} */ let descriptor;
let home = serviceHome(app);
/** @type {InstanceType<typeof SharedPowerMonitor>|undefined} */ let power;
const FINALIZATION_TIMEOUT_MS = 5000;
/** @type {Promise<void>|undefined} */ let finalization;
/** @type {NodeJS.Timeout|undefined} */ let finalizationTimer;
let exited = false;
/** @type {ReturnType<typeof watchApplicationLifetime>|undefined} */ let applicationLifetime;
const {
  parseOwner,
  watchApplicationLifetime,
  scrubOwnerEnvironment,
} = require("./application-owner.cjs");

/** @param {number} exitCode */
function exitProcess(exitCode) {
  if (exited) return;
  exited = true;
  clearTimeout(finalizationTimer);
  try {
    for (const entry of backend?.ownedEngines?.values() ?? []) {
      for (const lifetime of entry.lifetimes ?? []) {
        try {
          lifetime.destroy();
        } catch {
          exitCode = 1;
        }
      }
    }
  } finally {
    try {
      applicationLifetime?.destroy();
    } catch {
      exitCode = 1;
    }
    try {
      diagnostics.record({ type: "exit-requested", exitCode });
    } finally {
      app.exit(exitCode);
    }
  }
}
/** @param {'completed-lifecycle'|'external-quit'|'signal'} cause */
function finish(cause) {
  if (finalization || exited) return finalization;
  /** @type {'disconnect'|'metadata'} */
  let stage = "disconnect";
  finalizationTimer = setTimeout(() => {
    try {
      diagnostics.record({ type: "desktop-exit-timeout", cause, stage });
    } finally {
      exitProcess(1);
    }
  }, FINALIZATION_TIMEOUT_MS);
  finalization = Promise.resolve()
    .then(async () => {
      power?.close();
      service?.close();
      await backend?.disconnect();
      stage = "metadata";
      if (descriptor) {
        try {
          const path = join(home, "service.json");
          /** @type {unknown} */
          const saved = JSON.parse(await readFile(path, "utf8"));
          if (record(saved) && saved.token === descriptor.token) await rm(path);
        } catch (error) {
          if (desktopError(error).code !== "ENOENT") throw error;
        }
      }
      exitProcess(0);
    })
    .catch(() => {
      exitProcess(1);
    });
  return finalization;
}
async function start() {
  // Stopping an existing service needs only its private connection metadata,
  // not the binary or launch configuration used to start a replacement.
  const recover = process.argv.includes("--areal-core-service-recover");
  if (recover || process.argv.includes("--areal-core-service-stop")) {
    const connection = new ServiceConnection();
    try {
      const metadata = await connection.connect(
        JSON.parse(await readFile(join(serviceHome(app), "service.json"), "utf8")),
      );
      let packet = readServicePacket(
        await connection.request("hello", { protocol: PROTOCOL, identity: metadata.identity }),
        metadata,
      );
      assertLifecycleSupport(packet.service, "stopDesktop");
      if (recover) {
        await app.whenReady();
        await createResourceRecovery({
          backend: {
            resources: (request) =>
              connection.request("resources", request, request.operation !== "inspect"),
          },
          notify: (options) => dialog.showMessageBox(options),
        })();
        packet = readServicePacket(await connection.request("snapshot"), metadata);
      }
      const lifecycle = assertLifecycleSupport(packet.service, "stopDesktop");
      /** @type {import('./service-control.cjs').LifecycleReference} */
      const reference = {
        requestId: randomUUID(),
        kind: "stopDesktop",
        mode: "ifIdle",
        desktopGeneration: lifecycle.desktopGeneration,
        targets: targets(readRecoveryService(packet.service).targets ?? []),
        desktop: { pid: metadata.pid, identity: metadata.identity },
      };
      const receipt = readLifecycleResponse(
        reference,
        await connection.request(
          "lifecycleRequest",
          {
            protocol: PROTOCOL,
            requestId: reference.requestId,
            kind: reference.kind,
            mode: reference.mode,
            expectedDesktopGeneration: reference.desktopGeneration,
            expectedTargets: reference.targets,
          },
          true,
        ),
      );
      if (receipt.desktopExit !== "requested")
        throw Object.assign(new Error("后台停止尚未完成，请检查原生命周期请求"), {
          lifecycle: receipt,
        });
      await waitForServiceProcessExit(serviceHome(app), metadata);
    } finally {
      connection.close();
    }
    startupTraceService.finish("skipped");
    app.exit(0);
    return;
  }
  parseOwner(process.env.AREAL_GUI_OWNER);
  applicationLifetime = watchApplicationLifetime(() => {
    try {
      diagnostics.record({ type: "application-owner-lost" });
    } finally {
      exitProcess(1);
    }
  });
  startupTraceService.advance("prepare_home");
  const options = serviceOptions(app);
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  home = options.home = await realpath(options.home);
  // Scope the OS-backed single-instance lock to the shared Core home, independent
  // of any GUI profile. Concurrent launchers converge on one writer.
  app.setPath("userData", join(home, ".service-user-data"));
  await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
  if (!app.requestSingleInstanceLock()) {
    startupTraceService.finish("skipped");
    app.exit(0);
    return;
  }
  const imported = await require("./gui-source.cjs").prepareGuiSource({
    app,
    guiUserData,
    coreHome: home,
    legacyServiceHome: options.harnessHome,
    encryption: safeStorage,
  });
  if (imported) {
    startupTraceService.finish("skipped");
    app.exit(imported.kind === "ready" ? 0 : 2);
    return;
  }
  diagnostics.start({
    role: "desktop",
    root: join(home, "diagnostics", "desktop"),
    appRunId: parseOwner(process.env.AREAL_GUI_OWNER)?.appRunId,
    version: app.getVersion(),
  });
  diagnostics.startCrashReporter({ app, crashReporter });
  app.on("child-process-gone", (_event, details) =>
    diagnostics.record({
      type: "child-process-gone",
      processType: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    }),
  );
  // This process owns background work and notifications, never windows. Dock
  // hiding alone leaves a duplicate entry in macOS Force Quit Applications.
  // The separate recovery entry above remains able to show native dialogs.
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  startupTraceService.advance("app_ready");
  await app.whenReady();
  startupTraceService.advance("proxy_discovery");
  const network = await resolveDesktopNetwork(readLibraryStartupSettings(home), process.env, {
    caBundleDirectory: join(home, "network-ca"),
  });
  const activeBackend = (backend = new CoreBackend({
    ...options,
    proxyEnvironment: network,
    encryption: safeStorage,
  }));
  startupTraceService.advance("proxy_relay");
  /** @type {Record<string,number>|undefined} */ let ports;
  try {
    /** @type {unknown} */
    const saved = JSON.parse(await readFile(join(home, "proxy-relays.json"), "utf8"));
    if (!record(saved)) throw new Error("本地代理转接配置无效");
    ports = Object.fromEntries(
      Object.entries(saved).map(([key, port]) => {
        if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
          throw new Error("本地代理转接端口无效");
        return [key, port];
      }),
    );
  } catch (error) {
    if (desktopError(error).code !== "ENOENT") throw error;
  }
  backend.proxyRelay = await proxyRelay(backend.proxyEnvironment, {
    ports,
    save: (ports) => activeBackend.save("proxy-relays.json", ports),
  });
  backend.proxyEnvironment = backend.proxyRelay.environment;
  startupTraceService.advance("backend_init");
  await backend.init();
  startupTraceService.advance("service_identity");
  const notifications = new BackgroundNotifications(Notification, () => {
    /** @type {NodeJS.ProcessEnv} */
    const env = {
      ...scrubOwnerEnvironment(),
      AREAL_BACKEND: "areal",
      AREAL_CORE_HOME: home,
      AREAL_GUI_USER_DATA: guiUserData,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = childProcess.spawn(
      desktopExecutables({ packaged: app.isPackaged }).gui,
      app.isPackaged ? [] : [app.getAppPath()],
      {
        detached: true,
        stdio: "ignore",
        env,
        windowsHide: false,
      },
    );
    child.once("error", (error) =>
      console.warn(activeBackend.providers.redact(`通知打开界面失败：${error.message}`)),
    );
    child.unref();
  });
  power = new SharedPowerMonitor(backend, powerSaveBlocker);
  service = new DesktopService(
    backend,
    await serviceIdentity(options),
    () => {
      void finish("completed-lifecycle");
    },
    notifications,
    power,
  );
  service.remote = new RemoteControl(service, safeStorage);
  startupTraceService.advance("remote_init");
  await service.remote.init();
  power.start();
  startupTraceService.advance("listen");
  descriptor = await service.listen();
  startupTraceService.advance("metadata");
  const temporary = join(home, `service-${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600 });
  await rename(temporary, join(home, "service.json"));
  startupTraceService.finish("ok");
  void backend.scheduleOwners.start();
}
app.on("window-all-closed", () => {});
app.on("before-quit", (event) => {
  event.preventDefault();
  void finish("external-quit");
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void finish("signal");
  });
void start().catch(async (/** @type {unknown} */ error) => {
  startupTraceService.finish("error", error);
  const message = desktopError(error).message;
  console.error(backend?.providers.redact(message) ?? message);
  service?.close();
  await backend?.proxyRelay?.close();
  diagnostics.record({ type: "exit-requested", exitCode: 1 });
  app.exit(1);
});
