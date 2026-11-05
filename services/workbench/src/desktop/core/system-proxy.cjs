// @ts-check
"use strict";
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { isIP } = require("node:net");
const execute = promisify(execFile);

/** @typedef {{http?:string,https?:string,socks?:string,exceptions:string[]}} SystemProxy */
/** @param {string} text */
function parseSystemProxy(text) {
  /** @type {Record<string,string>} */
  const settings = {},
    exceptions = [];
  let depth = 0,
    exceptionDepth = 0;
  for (const line of text.split("\n")) {
    if (line.includes("<dictionary> {") || line.includes("<array> {")) {
      depth++;
      if (depth === 2 && /^\s*ExceptionsList\s*:/.test(line)) exceptionDepth = depth;
    } else if (line.trim() === "}") {
      if (depth === exceptionDepth) exceptionDepth = 0;
      depth--;
    } else {
      const entry = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
      if (!entry) continue;
      if (depth === 1) settings[entry[1]] = entry[2];
      else if (exceptionDepth && depth === exceptionDepth) exceptions.push(entry[2]);
    }
  }
  /** @param {string} prefix @param {string} scheme */
  const proxy = (prefix, scheme) => {
    if (settings[`${prefix}Enable`] !== "1") return "";
    const host = settings[`${prefix}Proxy`],
      port = Number(settings[`${prefix}Port`]);
    if (!host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("系统代理地址或端口无效");
    return `${scheme}://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  };
  return {
    http: proxy("HTTP", "http"),
    https: proxy("HTTPS", "http"),
    socks: proxy("SOCKS", "socks5h"),
    exceptions,
  };
}

/** @param {NodeJS.ProcessEnv} [source] @param {NodeJS.Platform} [platform] @param {(file:string,args:string[],options:import("node:child_process").ExecFileOptionsWithStringEncoding)=>Promise<{stdout:string}>} [run] */
async function systemProxyEnvironment(
  source = process.env,
  platform = process.platform,
  run = execute,
) {
  /** @type {SystemProxy} */
  let system = { exceptions: [] };
  if (platform === "darwin") {
    // scutil 读取当前活动网络的静态代理，不执行终端脚本或修改系统设置。
    const { stdout } = await run("/usr/sbin/scutil", ["--proxy"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 128 * 1024,
    });
    system = parseSystemProxy(stdout);
  }
  /** @type {NodeJS.ProcessEnv} */
  const env = {},
    value = /** @param {string} name */ (name) => source[name] || source[name.toLowerCase()] || "";
  const all = value("ALL_PROXY");
  for (const [name, proxy] of Object.entries({
    HTTP_PROXY: value("HTTP_PROXY") || all || system.http || system.socks,
    HTTPS_PROXY: value("HTTPS_PROXY") || all || system.https || system.socks,
    ALL_PROXY: all || system.socks,
  }))
    if (proxy) env[name] = env[name.toLowerCase()] = proxy;
  // 本机带认证的控制和订阅地址必须直连；保留用户与系统的绕过条目。
  const bypass = [
    ...new Set(
      [
        value("NO_PROXY"),
        ...system.exceptions.map((item) => item.replace(/^\*\./, ".")),
        "localhost",
        ".localhost",
        "127.0.0.0/8",
        "::1",
      ].filter(Boolean),
    ),
  ].join(",");
  env.NO_PROXY = env.no_proxy = bypass;
  return env;
}

module.exports = { parseSystemProxy, systemProxyEnvironment };
