// @ts-check
"use strict";

const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { isAbsolute } = require("node:path");

/** @param {string} code */
function failure(code) {
  // Never expose CLI stdout/stderr: status can contain account and network data.
  return Object.assign(new Error(`Remote network: ${code}`), { code });
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @param {readonly string[]} keys @returns {value is Record<string,unknown>} */
const keysOnly = (value, keys) =>
  object(value) && Object.keys(value).every((key) => keys.includes(key));
/** @param {unknown} value @returns {value is number} */
const portNumber = (value) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;

/** @typedef {{TCP?:Record<string,{HTTPS?:boolean,HTTP?:boolean,TCPForward?:string,TerminateTLS?:string}>,Web?:Record<string,{Handlers:Record<string,{Path?:string,Proxy?:string,Text?:string}>}>,AllowFunnel?:Record<string,boolean>,Foreground?:Record<string,ServeConfig>}} ServeConfig */
/** @typedef {{host:'127.0.0.1',port:number}} RemoteListener */
/** @typedef {{schema:1,owner:'areal-remote',id:string,state:'proposed'|'pending'|'owned'|'removed',operation:'apply'|'remove'|'scope',publicOrigin:string,target:string,httpsPort:number,scope:'private'|'public',sourceScope?:'private'|'public'}} NetworkMapping */
/** @typedef {{available:true,persistentServe:true,version:string,login:string,https:string,policy:'unknown',funnelPorts:number[]|null,publicOrigin:string|null,config:ServeConfig,diagnostic?:undefined}} AvailableNetwork */
/** @typedef {AvailableNetwork|{available:boolean,persistentServe?:false,diagnostic:string,version?:undefined,login?:undefined,https?:undefined,policy?:undefined,funnelPorts?:undefined,publicOrigin?:undefined,config?:undefined}} NetworkInspection */
/** @typedef {{persistPending:(mapping:NetworkMapping)=>Promise<void>}} MutationOptions */
// Tailscale ipn.ServeConfig. Unknown additions fail closed before any mutation.
/** @param {unknown} value @returns {ServeConfig} */
function checkedConfig(value, depth = 0) {
  // No configured Serve instance is emitted as JSON null by the supported CLI.
  if (value === null && depth === 0) return {};
  assertServeConfig(value, depth);
  return value;
}
/** @param {unknown} value @param {number} depth @returns {asserts value is ServeConfig} */
function assertServeConfig(value, depth) {
  if (!keysOnly(value, ["TCP", "Web", "AllowFunnel", "Foreground"]) || depth > 4)
    throw failure("unknown-config");
  /** @type {Record<string,Record<string,unknown>>} */ const config = {};
  for (const [key, field] of Object.entries(value)) {
    if (!object(field)) throw failure("unknown-config");
    config[key] = field;
  }
  for (const [port, handler] of Object.entries(config.TCP || {})) {
    if (
      !/^[1-9]\d*$/.test(port) ||
      !portNumber(Number(port)) ||
      !keysOnly(handler, ["HTTPS", "HTTP", "TCPForward", "TerminateTLS"]) ||
      Object.entries(handler).some(
        ([key, v]) => typeof v !== (["HTTPS", "HTTP"].includes(key) ? "boolean" : "string"),
      )
    )
      throw failure("unknown-config");
  }
  for (const [hostPort, server] of Object.entries(config.Web || {})) {
    if (
      !/^[a-z0-9.-]+:[1-9]\d*$/.test(hostPort) ||
      !portNumber(Number(hostPort.split(":")[1])) ||
      !keysOnly(server, ["Handlers"]) ||
      !object(server.Handlers)
    )
      throw failure("unknown-config");
    for (const [route, handler] of Object.entries(server.Handlers)) {
      if (
        !route.startsWith("/") ||
        !keysOnly(handler, ["Path", "Proxy", "Text"]) ||
        Object.keys(handler).length !== 1 ||
        Object.values(handler).some((v) => typeof v !== "string")
      )
        throw failure("unknown-config");
    }
  }
  if (
    Object.entries(config.AllowFunnel || {}).some(
      ([key, v]) => !/^[a-z0-9.-]+:[1-9]\d*$/.test(key) || typeof v !== "boolean",
    )
  )
    throw failure("unknown-config");
  for (const child of Object.values(config.Foreground || {})) checkedConfig(child, depth + 1);
}

/** @param {unknown} value @returns {string} */
function validateHttpsOrigin(value) {
  try {
    if (typeof value !== "string") throw failure("invalid-origin");
    const url = new URL(value);
    if (
      typeof value !== "string" ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.origin !== value ||
      !url.hostname
    )
      throw failure("invalid-origin");
    return value;
  } catch {
    throw failure("invalid-origin");
  }
}

/** @param {unknown} listener @returns {RemoteListener} */
function checkedListener(listener) {
  if (
    !keysOnly(listener, ["host", "port"]) ||
    listener.host !== "127.0.0.1" ||
    !portNumber(listener.port)
  )
    throw failure("invalid-listener");
  return { host: listener.host, port: listener.port };
}

/** @param {unknown} record @returns {NetworkMapping} */
function checkedRecord(record) {
  if (!object(record)) throw failure("invalid-record");
  const normalized = { ...record, scope: record.scope === undefined ? "private" : record.scope };
  assertNetworkMapping(normalized);
  return normalized;
}
/** @param {unknown} record @returns {asserts record is NetworkMapping} */
function assertNetworkMapping(record) {
  if (
    !keysOnly(record, [
      "schema",
      "owner",
      "id",
      "state",
      "operation",
      "publicOrigin",
      "target",
      "httpsPort",
      "scope",
      "sourceScope",
    ]) ||
    record.schema !== 1 ||
    record.owner !== "areal-remote" ||
    typeof record.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(record.id) ||
    !(
      typeof record.state === "string" &&
      ["proposed", "pending", "owned", "removed"].includes(record.state)
    ) ||
    !(
      typeof record.operation === "string" &&
      ["apply", "remove", "scope"].includes(record.operation)
    ) ||
    !portNumber(record.httpsPort)
  )
    throw failure("invalid-record");
  const scope = record.scope === undefined ? "private" : record.scope;
  if (
    !(typeof scope === "string" && ["private", "public"].includes(scope)) ||
    (record.operation === "scope"
      ? !(
          typeof record.sourceScope === "string" &&
          ["private", "public"].includes(record.sourceScope)
        ) || record.sourceScope === scope
      : record.sourceScope !== undefined) ||
    (record.state === "proposed" && record.operation === "apply" && scope !== "private")
  )
    throw failure("invalid-record");
  validateHttpsOrigin(record.publicOrigin);
  const origin = new URL(validateHttpsOrigin(record.publicOrigin));
  if (Number(origin.port || 443) !== record.httpsPort || !/^[a-z0-9.-]+$/.test(origin.hostname))
    throw failure("invalid-record");
  const match =
    typeof record.target === "string" && /^http:\/\/127\.0\.0\.1:([1-9]\d*)$/.exec(record.target);
  if (!match || !portNumber(Number(match[1]))) throw failure("invalid-record");
}

/** @param {unknown} value */
const stable = (value) =>
  JSON.stringify(value, (_key, v) =>
    object(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
/** @param {unknown} a @param {unknown} b */
const same = (a, b) => stable(a) === stable(b);
/** @param {ServeConfig} config @param {number} port @returns {boolean} */
function portOccupied(config, port) {
  return (
    Object.hasOwn(config.TCP || {}, port) ||
    Object.keys(config.Web || {}).some((key) => key.endsWith(`:${port}`)) ||
    Object.keys(config.AllowFunnel || {}).some((key) => key.endsWith(`:${port}`)) ||
    Object.values(config.Foreground || {}).some((child) => portOccupied(child, port))
  );
}
/** @param {NetworkMapping} record */
function hostPort(record) {
  return `${new URL(record.publicOrigin).hostname}:${record.httpsPort}`;
}
/** @param {ServeConfig} config @param {NetworkMapping} record */
function ownership(config, record) {
  if (!portOccupied(config, record.httpsPort)) return "absent";
  const hp = hostPort(record);
  return same(config.TCP?.[record.httpsPort], { HTTPS: true }) &&
    same(config.Web?.[hp], { Handlers: { "/": { Proxy: record.target } } }) &&
    Object.keys(config.Web || {}).filter((key) => key.endsWith(`:${record.httpsPort}`)).length ===
      1 &&
    (record.scope === "public"
      ? config.AllowFunnel?.[hp] === true &&
        Object.keys(config.AllowFunnel).filter((key) => key.endsWith(`:${record.httpsPort}`))
          .length === 1
      : !Object.keys(config.AllowFunnel || {}).some((key) =>
          key.endsWith(`:${record.httpsPort}`),
        )) &&
    !Object.values(config.Foreground || {}).some((child) => portOccupied(child, record.httpsPort))
    ? "owned"
    : "changed";
}
/** @param {ServeConfig} config @param {NetworkMapping} record @param {boolean} remove */
function expectedAfter(config, record, remove) {
  const expected = structuredClone(config);
  const port = record.httpsPort,
    hp = hostPort(record);
  if (remove) {
    delete expected.TCP?.[port];
    delete expected.Web?.[hp];
    if (!Object.keys(expected.TCP ?? {}).length) delete expected.TCP;
    if (!Object.keys(expected.Web ?? {}).length) delete expected.Web;
  } else {
    expected.TCP ||= {};
    expected.Web ||= {};
    expected.TCP[port] = { HTTPS: true };
    expected.Web[hp] = { Handlers: { "/": { Proxy: record.target } } };
  }
  if (!remove && record.scope === "public") {
    expected.AllowFunnel ||= {};
    expected.AllowFunnel[hp] = true;
  } else if (expected.AllowFunnel && Object.hasOwn(expected.AllowFunnel, hp)) {
    delete expected.AllowFunnel[hp];
    if (!Object.keys(expected.AllowFunnel).length) delete expected.AllowFunnel;
  }
  return expected;
}

// 仅采用本机 CapMap 证据；不能通过执行 Funnel 探测或开启控制面的功能。
/** @param {Record<string,unknown>} status */
function funnelPorts(status) {
  const caps = object(status.Self) ? status.Self.CapMap : undefined;
  if (!object(caps) || Object.values(caps).some((value) => value !== null && !Array.isArray(value)))
    return null;
  if (!Object.hasOwn(caps, "https") || !Object.hasOwn(caps, "funnel")) return [];
  const prefix = "https://tailscale.com/cap/funnel-ports";
  const portCaps = Object.keys(caps).filter((key) => key.startsWith(prefix));
  // 上游没有定义多条端口能力的合并规则；歧义证据不能授权公网发布。
  if (portCaps.length !== 1) return null;
  const match = /^https:\/\/tailscale\.com\/cap\/funnel-ports\?ports=([0-9,-]+)$/.exec(portCaps[0]);
  if (!match) return null;
  /** @type {[number,number][]} */
  const ranges = [];
  for (const item of match[1].split(",")) {
    const parts = /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(item);
    if (!parts) return null;
    const low = Number(parts[1]),
      high = Number(parts[2] || parts[1]);
    if (!portNumber(low) || !portNumber(high) || low > high) return null;
    ranges.push([low, high]);
  }
  return [443, 8443, 10000].filter((port) =>
    ranges.some(([low, high]) => low <= port && port <= high),
  );
}

/** @param {{executable?:string,timeoutMs?:number,maxBuffer?:number,verifyRemoteListener?:(listener:RemoteListener)=>boolean|Promise<boolean>}} [options] */
function createRemoteNetworkAdapter({
  executable = "tailscale",
  timeoutMs = 5000,
  maxBuffer = 256 * 1024,
  verifyRemoteListener,
} = {}) {
  if (executable !== "tailscale" && !isAbsolute(executable)) throw failure("invalid-executable");
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000 ||
    !Number.isInteger(maxBuffer) ||
    maxBuffer < 1 ||
    maxBuffer > 1024 * 1024
  )
    throw failure("invalid-limits");
  /** @param {string[]} args @returns {Promise<string>} */
  const run = (args) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        args,
        { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer, shell: false, windowsHide: true },
        (error, stdout) => {
          if (error)
            return reject(
              failure(
                error.code === "ENOENT"
                  ? "unavailable"
                  : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                    ? "output-limit"
                    : error.killed
                      ? "timeout"
                      : "cli-failed",
              ),
            );
          resolve(stdout);
        },
      );
      child.stdin?.end();
    });
  /** @param {string[]} args @returns {Promise<unknown>} */
  const json = async (args) => {
    try {
      return JSON.parse(await run(args));
    } catch (error) {
      if (object(error) && error.code) throw error;
      throw failure("malformed-json");
    }
  };
  /** @returns {Promise<NetworkInspection>} */
  async function inspect() {
    let metadata;
    try {
      metadata = await json(["version", "--json"]);
    } catch (error) {
      if (object(error) && error.code === "unavailable")
        return { available: false, diagnostic: "unavailable" };
      throw error;
    }
    const version = object(metadata) ? metadata.short : undefined;
    const match = typeof version === "string" && /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 52)) {
      return { available: true, persistentServe: false, diagnostic: "unsupported-version" };
    }
    const status = await json(["status", "--json"]);
    if (!object(status)) throw failure("unknown-status");
    const config = checkedConfig(await json(["serve", "status", "--json"]));
    const dnsName =
      object(status.Self) && typeof status.Self.DNSName === "string"
        ? status.Self.DNSName.replace(/\.$/, "")
        : null;
    const validName = dnsName && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(dnsName);
    const domains =
      Array.isArray(status.CertDomains) &&
      status.CertDomains.every((name) => typeof name === "string")
        ? status.CertDomains
        : undefined;
    const logins = /** @type {Record<string,string>} */ ({
      Running: "logged-in",
      NeedsLogin: "not-logged-in",
      NeedsMachineAuth: "approval-required",
      Stopped: "stopped",
      Starting: "starting",
    });
    const login =
      typeof status.BackendState === "string"
        ? logins[status.BackendState] || "unknown"
        : "unknown";
    return {
      available: true,
      version: String(version),
      persistentServe: true,
      login,
      https:
        !domains || !validName ? "unknown" : domains.includes(dnsName) ? "enabled" : "disabled",
      // Local status cannot prove organizational ACLs or a phone's tailnet access.
      policy: "unknown",
      funnelPorts: funnelPorts(status),
      publicOrigin: validName ? `https://${dnsName}` : null,
      config,
    };
  }

  /** @param {RemoteListener} listener */
  async function verifyListener(listener) {
    checkedListener(listener);
    if (
      typeof verifyRemoteListener !== "function" ||
      (await verifyRemoteListener(listener)) !== true
    )
      throw failure("unverified-listener");
  }
  /** @param {NetworkInspection} snapshot @returns {asserts snapshot is AvailableNetwork & {publicOrigin:string}} */
  function ready(snapshot) {
    if (!snapshot.available || !snapshot.persistentServe)
      throw failure(snapshot.diagnostic || "unavailable");
    if (snapshot.login !== "logged-in") throw failure("not-logged-in");
    if (snapshot.https !== "enabled" || !snapshot.publicOrigin)
      throw failure(snapshot.https === "disabled" ? "https-disabled" : "https-unknown");
  }
  /** @param {{remoteListener?:unknown,httpsPort?:unknown}} [options] @returns {Promise<NetworkMapping>} */
  async function propose({ remoteListener, httpsPort = 443 } = {}) {
    const listener = checkedListener(remoteListener);
    if (!portNumber(httpsPort)) throw failure("invalid-port");
    await verifyListener(listener);
    const snapshot = await inspect();
    ready(snapshot);
    if (portOccupied(snapshot.config, httpsPort)) throw failure("mapping-collision");
    return {
      schema: 1,
      owner: "areal-remote",
      id: randomUUID(),
      state: "proposed",
      operation: "apply",
      scope: "private",
      publicOrigin: `${snapshot.publicOrigin}${httpsPort === 443 ? "" : `:${httpsPort}`}`,
      target: `http://127.0.0.1:${listener.port}`,
      httpsPort,
    };
  }
  /** @param {NetworkInspection} snapshot @param {NetworkMapping} record @returns {asserts snapshot is AvailableNetwork & {publicOrigin:string}} */
  function readyScope(snapshot, record) {
    ready(snapshot);
    if (record.scope === "public") {
      if (![443, 8443, 10000].includes(record.httpsPort)) throw failure("unsupported-funnel-port");
      if (snapshot.funnelPorts === null) throw failure("funnel-capability-unknown");
      if (!snapshot.funnelPorts.includes(record.httpsPort)) throw failure("funnel-port-denied");
    }
  }
  /** @param {unknown} input @param {"private"|"public"} desiredScope */
  async function proposeScope(input, desiredScope) {
    const record = checkedRecord(input);
    if (
      record.state !== "owned" ||
      !["private", "public"].includes(desiredScope) ||
      desiredScope === record.scope
    )
      throw failure("invalid-record");
    /** @type {NetworkMapping} */
    const proposal = {
      ...record,
      state: "proposed",
      operation: "scope",
      sourceScope: record.scope,
      scope: desiredScope,
    };
    await verifyListener({ host: "127.0.0.1", port: Number(new URL(record.target).port) });
    const snapshot = await inspect();
    readyScope(snapshot, proposal);
    if (
      `${snapshot.publicOrigin}${record.httpsPort === 443 ? "" : `:${record.httpsPort}`}` !==
      record.publicOrigin
    )
      throw failure("network-changed");
    if (ownership(snapshot.config, record) !== "owned") throw failure("mapping-changed");
    return proposal;
  }
  /** @param {unknown} input */
  async function reconcileScope(input) {
    const record = checkedRecord(input);
    if (record.state !== "pending" || record.operation !== "scope") throw failure("invalid-record");
    const snapshot = await inspect();
    if (!snapshot.config) throw failure(snapshot.diagnostic || "unavailable");
    const destination = ownership(snapshot.config, record);
    return {
      state:
        destination === "owned"
          ? "destination"
          : destination === "absent"
            ? "absent"
            : ownership(snapshot.config, {
                  ...record,
                  scope: record.sourceScope ?? record.scope,
                }) === "owned"
              ? "source"
              : "changed",
    };
  }
  /** @param {unknown} input */
  async function inspectOwnership(input) {
    const record = checkedRecord(input);
    const snapshot = await inspect();
    if (!snapshot.config) throw failure(snapshot.diagnostic || "unavailable");
    return { state: ownership(snapshot.config, record) };
  }
  // Serialize this owner's mutations; this is not a lock on external CLI writers.
  /** @type {Promise<unknown>} */ let tail = Promise.resolve();
  /** @template T @param {()=>Promise<T>} operation */
  function serial(operation) {
    const pending = tail.then(operation);
    tail = pending.catch(() => {});
    return pending;
  }
  /** @param {unknown} input @param {MutationOptions|undefined} options @param {NetworkMapping["operation"]} operation */
  function mutate(input, options, operation) {
    const remove = operation === "remove",
      changeScope = operation === "scope";
    // Snapshot caller input before waiting in the queue.
    const record = checkedRecord(input);
    const persistPending = options?.persistPending;
    return serial(async () => {
      if (typeof persistPending !== "function") throw failure("pending-persistence-required");
      if (
        (!remove && (record.state !== "proposed" || record.operation !== operation)) ||
        (remove && !["owned", "pending"].includes(record.state))
      )
        throw failure("invalid-record");
      if (!remove)
        await verifyListener({ host: "127.0.0.1", port: Number(new URL(record.target).port) });
      async function preflight() {
        const snapshot = await inspect();
        if (!remove) {
          readyScope(snapshot, record);
        } else if (!snapshot.config) throw failure(snapshot.diagnostic || "unavailable");
        const origin = `${snapshot.publicOrigin}${record.httpsPort === 443 ? "" : `:${record.httpsPort}`}`;
        if (origin !== record.publicOrigin) throw failure("network-changed");
        const current = ownership(
          snapshot.config,
          changeScope ? { ...record, scope: record.sourceScope ?? record.scope } : record,
        );
        if (remove || changeScope ? current !== "owned" : current !== "absent")
          throw failure(remove || changeScope ? "mapping-changed" : "mapping-collision");
        return snapshot.config;
      }
      await preflight();
      /** @type {NetworkMapping} */
      const pending = { ...record, state: "pending", operation };
      if (remove) delete pending.sourceScope;
      // Caller must durably persist this in the existing secure configuration owner.
      // Failure here causes no CLI mutation. Keep it on later failure for reconciliation.
      await persistPending({ ...pending });
      const before = await preflight();
      if (!remove)
        await verifyListener({ host: "127.0.0.1", port: Number(new URL(record.target).port) });
      const expected = expectedAfter(before, record, remove);
      await run([
        !remove && record.scope === "public" ? "funnel" : "serve",
        "--bg",
        `--https=${record.httpsPort}`,
        "--set-path=/",
        remove ? "off" : record.target,
      ]);
      const after = checkedConfig(await json(["serve", "status", "--json"]));
      if (!same(after, expected)) throw failure("mapping-verification-failed");
      /** @type {NetworkMapping} */
      const completed = { ...pending, state: remove ? "removed" : "owned" };
      return completed;
    });
  }
  return {
    inspect,
    propose,
    proposeScope,
    inspectOwnership,
    reconcileScope,
    apply: /** @param {unknown} record @param {MutationOptions} options */ (record, options) =>
      mutate(record, options, "apply"),
    changeScope: /** @param {unknown} record @param {MutationOptions} options */ (
      record,
      options,
    ) => mutate(record, options, "scope"),
    remove: /** @param {unknown} record @param {MutationOptions} options */ (record, options) =>
      mutate(record, options, "remove"),
  };
}

module.exports = { createRemoteNetworkAdapter, validateHttpsOrigin, checkedRecord };
