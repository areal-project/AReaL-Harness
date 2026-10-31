import { createIdentity, identityId } from "@areal/remote";
import { ClientState, RemoteConnection } from "@areal/remote-client";
import { DeviceStore, parsePairingLink } from "./device-store.mjs";

/** @typedef {{kind:"loading"|"connecting"|"offline"|"background"|"revoked"|"blocked"}|{kind:"unpaired",cleared?:boolean,error?:"invalidLink"|"pairFailed"}|{kind:"pairing",fingerprint:string}|{kind:"connected",ready:{capabilities:string[],grantRevision:number,hostId:string,gatewayGeneration:string},remembered:boolean,fingerprint:string}} MobileConnectionState */
export class MobileClient {
  /** @param {{keychain: import("./device-store.mjs").DeviceStore["keychain"], clientKind:"ios"|"android", socket?:(url:string)=>WebSocket}} options */
  constructor({ keychain, clientKind, socket = (url) => new WebSocket(url) }) {
    this.clientKind = clientKind;
    this.store = new DeviceStore(keychain);
    this.identities = new ClientState({ createIdentity, identityId, store: this.store });
    this.socket = socket;
    this.listeners = new Set();
    /** @type {MobileConnectionState} */
    this.state = { kind: "loading" };
    this.epoch = 0;
    this.active = false;
    this.attempts = 0;
    this.onSession = () => {};
    this.onReady = async () => {};
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
      this.publish({ kind: "background" });
      return;
    }
    await this.restore();
  }
  async restore() {
    const epoch = this.epoch;
    let hasDevice = false;
    this.publish({ kind: "connecting" });
    try {
      const device = await this.store.load();
      if (epoch !== this.epoch || !this.active) return;
      const token = await this.identities.restore();
      if (epoch !== this.epoch || !this.active) return;
      if (!device || !token) {
        this.publish({ kind: "unpaired" });
        return;
      }
      hasDevice = true;
      await this.connect(
        { host: token.hostId, room: token.relayRoom, relayOrigin: device.relayOrigin },
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
      this.publish({ kind: "connecting" });
      const guest = await this.identities.guest();
      const token = await this.identities.prepareRemember(guest);
      if (epoch !== this.epoch || !this.active) return;
      await this.connect(pairing, token, epoch, displayName);
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.connection?.socket.close();
      this.publish({
        kind: "unpaired",
        error: error.message === "INVALID_PAIRING_LINK" ? "invalidLink" : "pairFailed",
      });
    }
  }
  async connect(target, token, epoch, displayName) {
    const deviceName = displayName ?? (await this.store.keychain.deviceName()).name;
    if (epoch !== this.epoch || !this.active) return;
    const socket = this.socket(`${target.relayOrigin.replace("https:", "wss:")}/remote/socket`);
    const connection = new RemoteConnection({
      socket,
      identity: token.identity,
      host: target.host,
      room: target.room,
      hello: {
        clientKind: this.clientKind,
        displayName: deviceName,
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
        if (event === "pairing") this.publish({ kind: "pairing", fingerprint: token.peerId });
      },
      onReady: async (ready) => {
        if (ready.apiVersion !== "areal.remote.v2")
          throw Object.assign(new Error("PROTOCOL_MISMATCH"), { code: "PROTOCOL_MISMATCH" });
        this.identityTarget = { host: target.host, room: target.room };
        this.store.connection = {
          relayOrigin: target.relayOrigin,
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
    this.publish({ kind: "connected", ready, remembered, fingerprint: token.peerId });
    await this.onReady(ready);
  }
  failure(error, reconnect) {
    const code = error?.code;
    if (
      [
        "AUTH_REVOKED",
        "GRANT_CHANGED",
        "PROTOCOL_MISMATCH",
        "PROTOCOL_UNSUPPORTED",
        "CORE_INCOMPATIBLE",
        "FORBIDDEN",
        "HOST_MISMATCH",
      ].includes(code)
    ) {
      this.disconnect();
      this.publish({ kind: ["AUTH_REVOKED", "FORBIDDEN"].includes(code) ? "revoked" : "blocked" });
      return;
    }
    this.publish({ kind: reconnect ? "offline" : "blocked" });
    if (!reconnect) return;
    const delay = Math.min(
      30000,
      500 * 2 ** Math.min(this.attempts++, 6) * (1 + Math.random() * 0.2),
    );
    this.retry = setTimeout(() => {
      if (this.active) {
        this.disconnect();
        void this.restore();
      }
    }, delay);
  }
  async clear() {
    this.disconnect();
    this.identities.invalidate();
    this.publish({ kind: "blocked" });
    await this.store.clear();
    this.store.connection = null;
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
      if (["AUTH_REVOKED", "GRANT_CHANGED"].includes(error?.code)) this.failure(error, false);
      throw error;
    }
  }
}
