import { remoteLocator } from "@areal/remote/wire";
import { isLocalRelayOrigin, isPinnedRelayOrigin } from "./local-socket.mjs";

export function parsePairingLink(value, { requireInvite = true } = {}) {
  try {
    const url = new URL(value);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const authority = /^https?:\/\/([^/]+)/.exec(value)?.[1];
    const local = fragment.get("local") === "1";
    const fingerprint = fragment.get("cert");
    const legacyLocal =
      local &&
      fingerprint === null &&
      isLocalRelayOrigin(url.origin) &&
      (authority === url.host || authority === `${url.hostname}:80`);
    const pinnedLocal =
      local &&
      isPinnedRelayOrigin(url.origin, fingerprint) &&
      (authority === url.host || authority === `${url.hostname}:443`);
    if (
      (local ? !legacyLocal && !pinnedLocal : url.protocol !== "https:" || fingerprint !== null) ||
      fragment.getAll("cert").length > 1 ||
      fragment.getAll("local").length > 1 ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search
    )
      throw new Error("INVALID_PAIRING_LINK");
    const { host, room } = remoteLocator(fragment);
    const invite = fragment.get("invite");
    if (!host || !room) throw new Error("INVALID_PAIRING_LINK");
    if (requireInvite && (!invite || !/^[a-f0-9]{64}$/.test(invite)))
      throw new Error("INVALID_PAIRING_LINK");
    if (invite && !/^[a-f0-9]{64}$/.test(invite)) throw new Error("INVALID_PAIRING_LINK");
    return {
      host,
      room,
      ...(invite ? { invite } : {}),
      ...(pinnedLocal ? { fingerprint } : {}),
      relayOrigin: url.origin,
    };
  } catch {
    throw new Error("INVALID_PAIRING_LINK");
  }
}

export function parseEndpointLink(value) {
  return parsePairingLink(value, { requireInvite: false });
}

export class DeviceStore {
  constructor(keychain) {
    this.keychain = keychain;
    this.queue = Promise.resolve();
    this.connection = null;
  }
  serial(action) {
    const result = this.queue.then(action);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async read() {
    const { value } = await this.keychain.load();
    if (value === null) return null;
    const device = JSON.parse(value);
    if (device.schema !== 1 || !Number.isSafeInteger(device.grantRevision) || !device.client)
      throw new Error("INVALID_DEVICE_RECORD");
    const origin = new URL(device.relayOrigin);
    if (
      (origin.protocol !== "https:" && !isLocalRelayOrigin(device.relayOrigin)) ||
      (device.fingerprint !== undefined &&
        !isPinnedRelayOrigin(device.relayOrigin, device.fingerprint)) ||
      origin.origin !== device.relayOrigin
    )
      throw new Error("INVALID_DEVICE_RECORD");
    return device;
  }
  load() {
    return this.serial(() => this.read());
  }
  transaction(write, action) {
    return this.serial(async () => {
      const device = await this.read();
      const { record, result } = action(device?.client);
      if (write) {
        const metadata = this.connection ?? device;
        if (!metadata) throw new Error("MISSING_DEVICE_CONNECTION");
        await this.keychain.save({
          value: JSON.stringify({
            schema: 1,
            relayOrigin: metadata.relayOrigin,
            ...(metadata.fingerprint ? { fingerprint: metadata.fingerprint } : {}),
            grantRevision: metadata.grantRevision,
            client: record,
          }),
        });
      }
      return result;
    });
  }
  clear() {
    return this.serial(() => this.keychain.clear());
  }
  close() {}
}
