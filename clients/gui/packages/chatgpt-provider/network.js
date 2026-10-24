import nodeFetch from "node-fetch";
import { ProxyAgent } from "proxy-agent";
import { ReadableStream } from "node:stream/web";
import { getCACertificates } from "node:tls";
import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";

export function proxyForUrl(url, source = process.env) {
  const target = new URL(url),
    host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ip = isIP(host),
    loopback = new BlockList();
  loopback.addSubnet("127.0.0.0", 8, "ipv4");
  loopback.addAddress("::1", "ipv6");
  // 本地订阅转发和 Core 控制请求携带本机凭据，始终绕过外部代理。
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (ip && loopback.check(host, ip === 6 ? "ipv6" : "ipv4"))
  )
    return "";
  const variable = (name) => source[name] || source[name.toLowerCase()] || "";
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  for (let entry of variable("NO_PROXY")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)) {
    if (entry === "*") return "";
    if (entry.includes("/")) {
      const [rawAddress, prefix] = entry.split("/"),
        address = rawAddress.replace(/^\[|\]$/g, ""),
        version = isIP(address),
        bits = Number(prefix);
      if (
        ip &&
        version === ip &&
        /^\d+$/.test(prefix) &&
        bits >= 0 &&
        bits <= (ip === 6 ? 128 : 32)
      ) {
        const block = new BlockList();
        block.addSubnet(address, bits, ip === 6 ? "ipv6" : "ipv4");
        if (block.check(host, ip === 6 ? "ipv6" : "ipv4")) return "";
      }
      continue;
    }
    const withPort = entry.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
    if (withPort) {
      if (withPort[2] !== port) continue;
      entry = withPort[1];
    }
    entry = entry.replace(/^\[|\]$/g, "").replace(/^\*\./, ".");
    const domain = entry.replace(/^\./, "");
    if (host === domain || (!isIP(domain) && host.endsWith(`.${domain}`))) return "";
  }
  if (source.AREAL_CHATGPT_SYSTEM_PROXY === "DIRECT") return "";
  return (
    source.AREAL_CHATGPT_SYSTEM_PROXY ||
    variable(target.protocol === "https:" ? "HTTPS_PROXY" : "HTTP_PROXY") ||
    variable("ALL_PROXY")
  );
}

// 请求独占 agent，使用可信适配器传入的代理快照，不修改全局 fetch 或环境。
export function subscriptionNetwork(source = process.env) {
  let agent;
  // 构造适配器不应访问系统 Keychain；仅在真正发起请求时加载系统信任根。
  // 继续保留系统、内置和额外 CA，绝不关闭 TLS 或主机名校验。
  function transport() {
    if (!agent) {
      const extra = [...new Set([source.SSL_CERT_FILE, source.NODE_EXTRA_CA_CERTS].filter(Boolean))]
        .map(path => readFileSync(path, "utf8"));
      const ca = [...new Set([...getCACertificates("default"), ...getCACertificates("system"), ...extra])];
      agent = new ProxyAgent({ ca, getProxyForUrl: (url) => proxyForUrl(url, source) });
    }
    return agent;
  }
  return {
    async fetch(url, init = {}) {
      if (source.AREAL_CHATGPT_PROXY_ERROR) throw new Error("ChatGPT proxy unavailable");
      const response = await nodeFetch(url, { ...init, agent: transport(), redirect: "error" });
      // Pull through the iterator: toWeb's data listener can enqueue after cancel.
      // Explicitly destroy on return, including cancellation before the first read.
      const body =
        response.body &&
        ReadableStream.from({
          [Symbol.asyncIterator]() {
            const iterator = response.body[Symbol.asyncIterator]();
            return {
              next: () => iterator.next(),
              return: () => {
                response.body.destroy();
                return iterator.return();
              },
            };
          },
        });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    close() {
      agent?.destroy();
    },
  };
}

export function oauthEnvironment(source = process.env) {
  const env = { ...source, PI_OAUTH_CALLBACK_HOST: "127.0.0.1" };
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_|CODEX_|AREAL_DESKTOP_BRIDGE_)/.test(key)) delete env[key];
  }
  return env;
}
