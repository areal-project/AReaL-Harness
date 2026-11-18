import { createIdentity, identityId } from "@areal/remote";
import { ClientState, RemoteConnection } from "@areal/remote-client";
import { DeviceStore, parseEndpointLink, parsePairingLink } from "./device-store.mjs";
import { createMobileSocket, LocalRelaySocket } from "./local-socket.mjs";

/** @typedef {{kind:"loading"}|{kind:"connecting"|"offline"|"background"|"revoked"|"blocked",hostId?:string,grantChanged?:boolean}|{kind:"unpaired",cleared?:boolean,error?:"invalidLink"|"pairFailed"|"localRelayUnreachable"}|{kind:"pairing",fingerprint:string,hostId?:string}|{kind:"connected",ready:{capabilities:string[],grantRevision:number,hostId:string,gatewayGeneration:string},remembered:boolean,fingerprint:string,hostId:string}} MobileConnectionState */
export class MobileClient {
  /** @param {{keychain: import("./device-store.mjs").DeviceStore["keychain"], clientKind:"ios"|"android", socket?:(url:string)=>WebSocket, capabilities?:string[]}} options */
  constructor({ keychain, clientKind, socket = createMobileSocket, capabilities }) {
    this.clientKind = clientKind;
    // 共享界面模式在同一条连接上协商 gui-read-v1/gui-write-v1；旧页面不声明，按原方法表工作。
    this.capabilities = capabilities;
    this.store = new DeviceStore(keychain);
    this.identities = new ClientState({ createIdentity, identityId, store: this.store });
    this.socket = socket;
    this.listeners = new Set();
    /** @type {MobileConnectionState} */
    this.state = { kind: "loading" };
    this.epoch = 0;
    this.active = false;
    this.attempts = 0;
    /** @type {string | undefined} */
    this.pairedHostId = undefined;
    /** @type {(message: unknown) => void} */
    this.onSession = () => {};
    /** @type {(ready: Extract<MobileConnectionState, {kind:"connected"}>["ready"]) => Promise<void>} */
    this.onReady = async (_ready) => {};
    /** @type {(hostId?: string) => void | Promise<void>} */
    this.onRevoked = () => {};
    /** @type {(hostId?: string) => void | Promise<void>} */
    this.onCleared = () => {};
  }
  snapshot = () => this.state;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** @param {MobileConnectionState} state */
  publish(state) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  disconnect() {
    this.epoch++;
    clearTimeout(this.retry);
    const connection = this.connection;
    this.connection = null;
    connection?.socket.close();
    connection?.rejectPending();
  }
  async setActive(active) {
    this.active = active;
    this.disconnect();
    if (!active) {
      this.publish({
        kind: "background",
        ...(this.pairedHostId ? { hostId: this.pairedHostId } : {}),
      });
      return;
    }
    await this.restore();
  }
  async restore() {
    const epoch = this.epoch;
    let hasDevice = false;
    this.publish({
      kind: "connecting",
      ...(this.pairedHostId ? { hostId: this.pairedHostId } : {}),
    });
    try {
      const device = await this.store.load();
      if (epoch !== this.epoch || !this.active) return;
      const token = await this.identities.restore();
      if (epoch !== this.epoch || !this.active) return;
      if (!device || !token) {
        this.pairedHostId = undefined;
        this.publish({ kind: "unpaired" });
        return;
      }
      hasDevice = true;
      this.pairedHostId = token.hostId;
      this.publish({ kind: "connecting", hostId: token.hostId });
      await this.connect(
        {
          host: token.hostId,
          room: token.relayRoom,
          relayOrigin: device.relayOrigin,
          fingerprint: device.fingerprint,
        },
        token,
        epoch,
      );
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.failure(error, hasDevice);
    }
  }
  async pair(value, displayName) {
    this.disconnect();
    const epoch = this.epoch;
    try {
      const pairing = parsePairingLink(value);
      value = "";
      this.pairedHostId = undefined;
      this.publish({ kind: "connecting" });
      const guest = await this.identities.guest();
      const token = await this.identities.prepareRemember(guest);
      if (epoch !== this.epoch || !this.active) return;
      await this.connect(pairing, token, epoch, displayName);
    } catch (error) {
      if (epoch !== this.epoch) return;
      const socket = this.connection?.socket;
      socket?.close();
      this.publish({
        kind: "unpaired",
        error:
          error.message === "INVALID_PAIRING_LINK"
            ? "invalidLink"
            : socket instanceof LocalRelaySocket && !socket.opened
              ? "localRelayUnreachable"
              : "pairFailed",
      });
    }
  }
  /** 电脑切换 Wi-Fi 导致本机 Relay IP 变更时，保留身份和缓存只更新同 Host 的连接入口。 */
  async updateEndpoint(value) {
    const endpoint = parseEndpointLink(value);
    const token = this.identities.current();
    if (!token || token.mode !== "remembered" || token.hostId !== endpoint.host) {
      throw Object.assign(new Error("HOST_MISMATCH"), { code: "HOST_MISMATCH" });
    }
    const previous = await this.store.load();
    if (previous?.fingerprint && previous.fingerprint !== endpoint.fingerprint)
      throw Object.assign(new Error("HOST_MISMATCH"), { code: "HOST_MISMATCH" });
    this.disconnect();
    const epoch = this.epoch;
    this.store.connection = {
      relayOrigin: endpoint.relayOrigin,
      fingerprint: endpoint.fingerprint,
      grantRevision: previous?.grantRevision ?? 0,
    };
    await this.identities.remember(token, endpoint.host, endpoint.room);
    if (epoch === this.epoch && this.active) {
      this.attempts = 0;
      await this.restore();
    }
  }
  async connect(target, token, epoch, displayName) {
    const deviceName = displayName ?? (await this.store.keychain.deviceName()).name;
    if (epoch !== this.epoch || !this.active) return;
    const socket = this.socket(
      `${target.relayOrigin.replace(/^http/, "ws")}/remote/socket`,
      target.fingerprint,
    );
    const connection = new RemoteConnection({
      socket,
      identity: token.identity,
      host: target.host,
      room: target.room,
      hello: {
        clientKind: this.clientKind,
        displayName: deviceName,
        ...(this.capabilities ? { capabilities: this.capabilities } : {}),
        ...(target.invite ? { inviteSecret: target.invite } : {}),
      },
      isCurrent: () => epoch === this.epoch && this.active,
      onClose: () => {
        if (epoch !== this.epoch || !this.active || this.state.kind !== "connected") return;
        this.failure(new Error("OFFLINE"), true);
      },
    });
    this.connection = connection;
    let remembered = true;
    const ready = await connection.connect({
      onHandshake: (event) => {
        delete target.invite;
        if (event === "pairing")
          this.publish({ kind: "pairing", fingerprint: token.peerId, hostId: target.host });
      },
      onReady: async (ready) => {
        if (ready.apiVersion !== "areal.remote.v2")
          throw Object.assign(new Error("PROTOCOL_MISMATCH"), { code: "PROTOCOL_MISMATCH" });
        this.pairedHostId = target.host;
        this.identityTarget = { host: target.host, room: target.room };
        this.store.connection = {
          relayOrigin: target.relayOrigin,
          fingerprint: target.fingerprint,
          grantRevision: ready.grantRevision,
        };
        try {
          token = await this.identities.remember(token, target.host, target.room);
        } catch {
          remembered = false;
        }
      },
      onSession: (message) => this.onSession(message),
    });
    if (epoch !== this.epoch) return;
    this.attempts = 0;
    this.publish({
      kind: "connected",
      ready,
      remembered,
      fingerprint: token.peerId,
      hostId: target.host,
    });
    await this.onReady(ready);
  }
  failure(error, reconnect) {
    const code = error?.code;
    if (
      [
        "AUTH_REVOKED",
        "PROTOCOL_MISMATCH",
        "PROTOCOL_UNSUPPORTED",
        "CORE_INCOMPATIBLE",
        "FORBIDDEN",
        "HOST_MISMATCH",
      ].includes(code)
    ) {
      const revokedHost = this.pairedHostId;
      this.disconnect();
      const revoked = ["AUTH_REVOKED", "FORBIDDEN"].includes(code);
      if (revoked) void Promise.resolve(this.onRevoked?.(revokedHost)).catch(() => {});
      this.publish({
        kind: revoked ? "revoked" : "blocked",
        ...(revokedHost ? { hostId: revokedHost } : {}),
      });
      return;
    }
    this.publish({
      kind: reconnect ? "offline" : "blocked",
      ...(code === "GRANT_CHANGED" ? { grantChanged: true } : {}),
      ...(this.pairedHostId ? { hostId: this.pairedHostId } : {}),
    });
    if (!reconnect) return;
    // 桌面变更授权项目后返回 GRANT_CHANGED，立即快速重连以拉取新的授权项目范围与版本号。
    const delay =
      code === "GRANT_CHANGED"
        ? 300
        : Math.min(30000, 500 * 2 ** Math.min(this.attempts++, 6) * (1 + Math.random() * 0.2));
    this.retry = setTimeout(() => {
      if (this.active) {
        this.disconnect();
        void this.restore();
      }
    }, delay);
  }
  async clear() {
    const hostId = this.pairedHostId;
    this.disconnect();
    this.identities.invalidate();
    this.publish({ kind: "blocked", ...(hostId ? { hostId } : {}) });
    await this.store.clear();
    await Promise.resolve(this.onCleared?.(hostId)).catch(() => {});
    this.store.connection = null;
    this.pairedHostId = undefined;
    this.publish({ kind: "unpaired", cleared: true });
  }
  async remember() {
    const token = this.identities.current();
    if (this.state.kind !== "connected" || !token)
      throw Object.assign(new Error("LOCAL_NOT_SENT"), { code: "LOCAL_NOT_SENT" });
    if (token.mode === "remembered") return token;
    try {
      const remembered = await this.identities.remember(
        token,
        this.identityTarget.host,
        this.identityTarget.room,
      );
      if (this.state.kind === "connected") this.publish({ ...this.state, remembered: true });
      return remembered;
    } catch {
      throw Object.assign(new Error("DEVICE_SAVE_FAILED"), { code: "DEVICE_SAVE_FAILED" });
    }
  }
  async request(envelope, onResult) {
    if (this.state.kind !== "connected") throw new Error("OFFLINE");
    try {
      return await this.connection.request(envelope, onResult);
    } catch (error) {
      if (error?.code === "AUTH_REVOKED") this.failure(error, false);
      else if (error?.code === "GRANT_CHANGED") this.failure(error, true);
      throw error;
    }
  }
}
