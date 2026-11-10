import { createIdentity, identityId, secureChannel } from "../../packages/remote/src/channel.mjs";
import { createRemoteWire } from "../../packages/remote/src/wire.mjs";
import type {
  ProbeConfig,
  ProbeBridge,
  ProbeCapabilities,
  ProbePhase,
  ProbeResult,
} from "./mobile";

export async function runProbe(
  config: ProbeConfig,
  bridge: ProbeBridge,
  capabilities: ProbeCapabilities,
) {
  let phase: ProbePhase = "capabilities";
  let close = () => {};
  let finished = false;
  let webSocketOpened = false;
  const report = (result: ProbeResult) => {
    if (finished) return;
    finished = true;
    const status = document.getElementById("status");
    if (status) status.textContent = `${result.status} (${result.phase})`;
    bridge.postMessage({ kind: "result", result });
  };
  const deadline = setTimeout(() => {
    report({
      status: "failure",
      phase,
      origin: location.origin,
      capabilities,
      webSocketOpened,
      errorName: "ProbeTimeout",
      diagnostic: "No protocol result before deadline",
    });
    close();
  }, 25000);
  try {
    crypto.getRandomValues(new Uint8Array(32));
    phase = "identity";
    const identity = await createIdentity();
    phase = "relay";
    const socket = new WebSocket(`${config.relay.replace("https:", "wss:")}/remote/socket`);
    socket.addEventListener("open", () => {
      webSocketOpened = true;
    });
    close = () => socket.close();
    const { wire, ready } = createRemoteWire(socket, { room: config.room });
    await ready;
    phase = "noise";
    const secure = await secureChannel(wire, identity, config.host, {
      maxMessageBytes: 256 * 1024,
    });
    close = () => secure.close();
    phase = "hello";
    secure.send({
      method: "hello",
      apiVersion: "areal.remote.v2",
      clientVersion: "ios-gate",
      displayName: "iOS gate",
      inviteSecret: config.invite,
    });
    const messages = secure.messages();
    const pairing = (await messages.next()).value as { event?: string } | undefined;
    if (pairing?.event !== "pairing") throw new Error("ExpectedPairing");
    bridge.postMessage({ kind: "pairing", peer: identityId(identity) });
    phase = "ready";
    const active = (await messages.next()).value as
      | { event?: string; hostId?: string; apiVersion?: string }
      | undefined;
    if (
      active?.event !== "ready" ||
      active.hostId !== config.host ||
      active.apiVersion !== "areal.remote.v2"
    )
      throw new Error("ReadyPinMismatch");
    phase = "project.list";
    secure.send({ id: "ios-gate-read", method: "project.list", params: {} });
    const reply = (await messages.next()).value as
      | { id?: string; result?: { projects?: { projectId: string }[] } }
      | undefined;
    if (reply?.id !== "ios-gate-read" || !Array.isArray(reply.result?.projects))
      throw new Error("InvalidProjectList");
    report({
      status: "success",
      phase,
      origin: location.origin,
      capabilities,
      webSocketOpened,
      verified: {
        hostPin: secure.peer === config.host,
        apiVersion: active.apiVersion,
        ready: true,
        projectIds: reply.result.projects.map(({ projectId }) => projectId),
      },
    });
  } catch (error) {
    report({
      status: "failure",
      phase,
      origin: location.origin,
      capabilities,
      webSocketOpened,
      errorName: error instanceof Error ? error.name : "UnknownError",
      diagnostic:
        error instanceof Error
          ? Object.values(config)
              .reduce((text, value) => text.split(value).join("[redacted]"), error.message) // raw-error-ok: 诊断上报，已脱敏
              .slice(0, 240)
          : "NonErrorFailure",
    });
  } finally {
    clearTimeout(deadline);
    close();
  }
}
