// @ts-check
"use strict";
const { openSync, fstatSync, readSync, closeSync, constants, existsSync } = require("node:fs");
const { mkdir, mkdtemp, writeFile } = require("node:fs/promises");
const { isAbsolute, join } = require("node:path");
const { tmpdir } = require("node:os");
const { X509Certificate, createHash, webcrypto } = require("node:crypto");
const { isIP } = require("node:net");
const tls = require("node:tls");
const { systemProxyEnvironment } = require("./system-proxy.cjs");

const MAX_CA_BYTES = 1024 * 1024;
const LOOPBACK_BYPASS = ["localhost", ".localhost", "127.0.0.0/8", "::1"];
const SUPPORTED_CRITICAL_EXTENSIONS = new Set(["2.5.29.15", "2.5.29.17", "2.5.29.19", "2.5.29.37"]);
const CA_FILE_ENV = [
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
];
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

function desktopTlsOptions() {
  const bundledCa = join(__dirname, "../../assets/relay-ca.pem");
  const roots = existsSync(bundledCa) ? readCaBundle(bundledCa).map((cert) => cert.toString()) : [];
  // 显式 ca 会替换 Node 默认根；同时保留公共根、启动时额外 CA 和系统信任根。
  return {
    ca: [
      ...new Set([
        ...tls.getCACertificates("default"),
        ...tls.getCACertificates("system"),
        ...roots,
      ]),
    ],
    rejectUnauthorized: true,
  };
}

/** @param {unknown} value @param {string} name */
function settingString(value, name, limit = 4096) {
  if (value === undefined) return "";
  if (
    typeof value !== "string" ||
    value.length > limit ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(`Invalid ${name}`);
  return value.trim();
}
/** @param {unknown} value */
function proxySetting(value) {
  const text = settingString(value, "HTTP proxy");
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("HTTP proxy must be an absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "HTTP proxy requires an HTTP(S) host and port without credentials, path or query",
    );
  return url.origin;
}
/** @param {unknown} value */
function bypassSetting(value) {
  const text = settingString(value, "proxy bypass");
  return [
    ...new Set(
      text
        .split(/[;,\s]+/)
        .filter(Boolean)
        .map((raw) => {
          const entry = raw
            .toLowerCase()
            .replace(/^\*\./, ".")
            .replace(/^\[([^\]]+)\]$/, "$1");
          if (entry === "*" || isIP(entry)) return entry;
          if (entry.includes("/")) {
            const [address, bits, extra] = entry.split("/");
            const version = isIP(address);
            if (
              !extra &&
              version &&
              /^\d+$/.test(bits) &&
              Number(bits) <= (version === 6 ? 128 : 32)
            )
              return `${address}/${Number(bits)}`;
          } else if (
            /^\.?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?$/.test(
              entry,
            ) &&
            entry.length <= 253
          )
            return entry.replace(/\.$/, "");
          throw new Error(
            "Proxy bypass supports hosts, domains, IP addresses and CIDR ranges without ports",
          );
        }),
    ),
  ].join(",");
}
/** @param {string} path */
function readCaBundle(path, requireSelfSigned = true) {
  if (!isAbsolute(path)) throw new Error("CA certificate must be an absolute PEM file path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let text;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CA_BYTES)
      throw new Error("CA certificate must be a regular PEM file no larger than 1 MiB");
    const buffer = Buffer.alloc(MAX_CA_BYTES + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count > MAX_CA_BYTES) throw new Error("CA certificate exceeds 1 MiB");
    text = buffer.subarray(0, count).toString("utf8");
  } finally {
    closeSync(fd);
  }
  const blocks = text.match(PEM_CERTIFICATE) ?? [];
  if (
    !blocks.length ||
    blocks.length > (requireSelfSigned ? 128 : 1024) ||
    (requireSelfSigned && text.replace(PEM_CERTIFICATE, "").trim())
  )
    throw new Error("CA certificate must contain only PEM certificates");
  const roots = blocks.map((pem) => new X509Certificate(pem));
  if (
    requireSelfSigned &&
    roots.some((cert) => !cert.ca || !cert.checkIssued(cert) || !cert.verify(cert.publicKey))
  )
    throw new Error("CA bundle must contain self-signed certificate authorities");
  return roots;
}
/** @param {string} key @param {unknown} value */
function normalizeNetworkSetting(key, value) {
  if (key === "httpProxy") return proxySetting(value);
  if (key === "httpProxyNoProxy") return bypassSetting(value);
  if (key === "httpProxyCaCertPath") {
    const path = settingString(value, "CA certificate path");
    if (path) readCaBundle(path);
    return path;
  }
  throw new Error("Unknown network setting");
}
/** @typedef {{httpProxy?:unknown,httpProxyNoProxy?:unknown,httpProxyCaCertPath?:unknown}} DesktopNetworkSettings */
/** @param {DesktopNetworkSettings} [settings] @param {NodeJS.ProcessEnv} [source]
 * @param {{platform?:NodeJS.Platform,run?:Parameters<typeof systemProxyEnvironment>[2],caBundleDirectory?:string}} [options] */
async function resolveDesktopNetwork(settings = {}, source = process.env, options = {}) {
  const proxy = proxySetting(settings.httpProxy);
  const bypass = bypassSetting(settings.httpProxyNoProxy);
  const caPath = normalizeNetworkSetting("httpProxyCaCertPath", settings.httpProxyCaCertPath);
  /** @type {NodeJS.ProcessEnv} */
  const env = proxy
    ? Object.fromEntries(
        ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].map(
          (key) => [key, proxy],
        ),
      )
    : await systemProxyEnvironment(source, options.platform, options.run);
  if (proxy) env.AREAL_CHATGPT_SYSTEM_PROXY = proxy;
  env.NO_PROXY = env.no_proxy = [
    ...new Set([env.NO_PROXY, bypass, ...LOOPBACK_BYPASS].filter(Boolean)),
  ].join(",");
  for (const key of [...CA_FILE_ENV, "SSL_CERT_DIR"]) if (source[key]) env[key] = source[key];
  if (caPath) {
    const roots = readCaBundle(caPath).map((cert) => cert.toString());
    for (const inherited of new Set(
      CA_FILE_ENV.map((key) => source[key]).filter((value) => typeof value === "string"),
    ))
      roots.push(...readCaBundle(inherited, false).map((cert) => cert.toString()));
    const combined = [
      ...new Set([
        ...tls.getCACertificates("default"),
        ...tls.getCACertificates("system"),
        ...roots,
      ]),
    ].join("\n");
    const directory =
      options.caBundleDirectory ?? (await mkdtemp(join(tmpdir(), "areal-network-ca-")));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${createHash("sha256").update(combined).digest("hex")}.pem`);
    try {
      await writeFile(path, combined, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    env.SSL_CERT_FILE = path;
    env.NODE_EXTRA_CA_CERTS = path;
    env.REQUESTS_CA_BUNDLE = env.CURL_CA_BUNDLE = env.GIT_SSL_CAINFO = path;
  }
  return env;
}

/** @param {import("electron").Request} request @param {X509Certificate[]} roots */
async function verifyAdditionalCertificate(request, roots) {
  const { Certificate, CertificateChainValidationEngine, CryptoEngine } = require("pkijs");
  const chain = [],
    seen = new Set();
  for (let current = request.certificate; current; current = current.issuerCert) {
    if (typeof current.data !== "string" || current.data.length > 64 * 1024) return false;
    const cert = new X509Certificate(current.data);
    if (seen.has(cert.fingerprint256)) break;
    if (chain.length === 8) return false;
    seen.add(cert.fingerprint256);
    chain.push(cert);
  }
  if (!chain.length || chain[0].ca) return false;
  const host = request.hostname.replace(/^\[|\]$/g, "");
  if (!(isIP(host) ? chain[0].checkIP(host) : chain[0].checkHost(host, { subject: "never" })))
    return false;
  const parsed = chain.map((cert) => Certificate.fromBER(cert.raw));
  const trustedCerts = roots.map((cert) => Certificate.fromBER(cert.raw));
  const engine = new CertificateChainValidationEngine({ certs: parsed.reverse(), trustedCerts });
  const crypto = new CryptoEngine({
    name: "NodeWebCrypto",
    crypto: /** @type {Crypto} */ (webcrypto),
  });
  const result = await engine.verify({}, crypto);
  if (!result.result) return false;
  for (const [index, cert] of engine.certs.entries()) {
    for (const extension of cert.extensions ?? []) {
      if (
        extension.parsedValue?.parsingError !== undefined ||
        (extension.critical &&
          (!SUPPORTED_CRITICAL_EXTENSIONS.has(extension.extnID) || !extension.parsedValue))
      )
        return false;
      if (
        extension.extnID === "2.5.29.37" &&
        !extension.parsedValue.keyPurposes.some(
          /** @param {string} oid */ (oid) => ["1.3.6.1.5.5.7.3.1", "2.5.29.37.0"].includes(oid),
        )
      )
        return false;
      if (
        extension.extnID === "2.5.29.19" &&
        extension.parsedValue.pathLenConstraint !== undefined &&
        Math.max(0, index - 1) > extension.parsedValue.pathLenConstraint
      )
        return false;
      if (
        index === 0 &&
        extension.extnID === "2.5.29.15" &&
        !(extension.parsedValue.valueBlock.valueHexView[0] & 0xa0)
      )
        return false;
    }
  }
  return true;
}
/** @param {import('electron').Session} session @param {DesktopNetworkSettings} [settings]
 * @param {{fallbackProxyMode?:'direct'|'auto_detect'|'pac_script'|'fixed_servers'|'system'}} [options] */
async function applyDesktopSessionNetworkPolicy(
  session,
  settings = {},
  { fallbackProxyMode = "system" } = {},
) {
  const proxy = proxySetting(settings.httpProxy);
  const bypass = bypassSetting(settings.httpProxyNoProxy);
  const caPath = normalizeNetworkSetting("httpProxyCaCertPath", settings.httpProxyCaCertPath);
  if (proxy) {
    const entries = [...new Set([...bypass.split(",").filter(Boolean), ...LOOPBACK_BYPASS])];
    const chromiumBypass = entries.flatMap((entry) => {
      if (entry === "*" || entry.includes("/") || isIP(entry))
        return [isIP(entry) === 6 ? `[${entry}]` : entry];
      const domain = entry.replace(/^\./, "");
      return [domain, `*.${domain}`];
    });
    await session.setProxy({
      mode: "fixed_servers",
      proxyRules: proxy,
      proxyBypassRules: chromiumBypass.join(","),
    });
  } else await session.setProxy({ mode: fallbackProxyMode });
  await session.closeAllConnections();
  if (!caPath) {
    session.setCertificateVerifyProc(null);
    return;
  }
  const roots = readCaBundle(caPath);
  session.setCertificateVerifyProc((request, callback) => {
    // Preserve Chromium's public roots and non-authority failures, including revocation.
    if (
      request.verificationResult !== "net::ERR_CERT_AUTHORITY_INVALID" &&
      request.errorCode !== -202
    ) {
      callback(-3);
      return;
    }
    void verifyAdditionalCertificate(request, roots).then(
      (valid) => callback(valid ? 0 : -3),
      () => callback(-3),
    );
  });
}
module.exports = {
  desktopTlsOptions,
  normalizeNetworkSetting,
  resolveDesktopNetwork,
  applyDesktopSessionNetworkPolicy,
};
