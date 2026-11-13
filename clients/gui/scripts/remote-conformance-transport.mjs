// 仅测试传输启动与证据边界；授权、业务和持久化仍由生产 Host 拥有。
export function selectRemoteTransport(value = process.env.AREAL_REMOTE_TRANSPORT) {
  if (value === undefined) return "direct";
  if (value !== "direct" && value !== "relay")
    throw new Error("AREAL_REMOTE_TRANSPORT must be direct or relay");
  return value;
}

export async function startConformanceTransport(transport) {
  if (transport === "direct")
    return {
      hostOptions: {},
      childEnv: {},
      socketOptions: {},
      evidence: { transport, trust: "existing Direct loopback" },
      async close() {},
    };
  const { certificates, relayFixture } = await import("./remote-relay-fixture.mjs");
  const { readFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const cleanup = [];
  const evidence = {
    transport,
    trust: "isolated public CA; Node request/Host process only",
    cleanup: [],
  };
  let tlsHome;
  async function close() {
    for (const action of cleanup.splice(0).reverse()) {
      try {
        await action();
      } catch (error) {
        evidence.cleanup.push({ error: error.message });
      }
    }
    if (evidence.cleanup.some((entry) => entry.error))
      throw new Error("Relay fixture cleanup failed");
  }
  try {
    tlsHome = await certificates();
    cleanup.push(() => rm(tlsHome, { recursive: true, force: true }));
    const caPath = join(tlsHome, "ca.pem"),
      ca = await readFile(caPath);
    evidence.caSha256 = createHash("sha256").update(ca).digest("hex");
    const relay = await relayFixture({ after: (action) => cleanup.push(action) }, { tlsHome });
    evidence.resources = relay.resources;
    evidence.configSha256 = createHash("sha256")
      .update(await readFile(relay.config))
      .digest("hex");
    evidence.artifacts = { assets: "not served: native Node business only" };
    return {
      hostOptions: { relay: relay.origin, code: relay.admin("enrollment").code },
      childEnv: { NODE_EXTRA_CA_CERTS: caPath },
      socketOptions: { ca },
      evidence,
      stateDirectory: relay.home,
      caDirectory: tlsHome,
      stopRelay: () => relay.stop(),
      close,
    };
  } catch (error) {
    if (error.fixtureResources) evidence.resources = error.fixtureResources;
    try {
      await close();
    } catch {
      /* 清理错误已写入 evidence，仍保留原启动失败。 */
    }
    error.transportEvidence = evidence;
    throw error;
  }
}

export async function initializeConformanceHost(remote, transport, options = {}) {
  if (transport === "direct")
    return { origin: remote.direct.origin, ws: remote.direct.ws, room: null };
  // 重启只复用持久登记；不会再消费登记码或改写已有授权。
  if (!remote.state().enabled)
    await remote.control({
      operation: "enable",
      relay: options.relay,
      code: options.code,
      confirmed: true,
    });
  const { waitFor } = await import("./remote-relay-fixture.mjs");
  await waitFor(() => remote.state().connected, 30000);
  const locator = new URL(remote.state().relayUrl);
  return {
    origin: locator.origin,
    ws: `${locator.origin.replace(/^https:/, "wss:")}/remote/socket`,
    room: new URLSearchParams(locator.hash.slice(1)).get("room"),
  };
}

export function browserTransportLimitation(transport) {
  return transport === "relay"
    ? {
        code: "RELAY_BROWSER_TLS_UNRUN",
        layer: "production-pwa-tls",
        status: "UNRUN",
        required: true,
        reason:
          "No supported isolated production browser CA fixture; Node TLS is not browser or phone acceptance",
      }
    : null;
}

export async function requireBrowserTransport(transport, suite) {
  const limitation = browserTransportLimitation(transport);
  if (!limitation) return;
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "rc16-unrun-"));
  const report = {
    suite,
    transport,
    status: "UNRUN",
    passed: false,
    acceptance: false,
    source: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: new URL("../../..", import.meta.url),
      encoding: "utf8",
    }).trim(),
    requiredUnrun: [limitation],
    coveredCases: [],
    requestedRepetitions: 0,
    completedRaceIterations: 0,
    processesStarted: [],
    phases: [{ phase: "preflight", status: "UNRUN", code: limitation.code }],
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence: directory, ...report }));
  process.exit(2);
}
