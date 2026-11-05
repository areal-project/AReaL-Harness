// @ts-check
"use strict";
// 已授权设备的桌面管理：撤销、重命名、清除已撤销记录。授权本身（approve/updateGrant）仍在 remote.cjs。
/** @typedef {import("./remote-config.cjs").DeviceGrant} DeviceGrant */
/** @typedef {InstanceType<typeof import("./remote.cjs").RemoteControl>} Remote */

/**
 * 同名的未撤销设备加序号，例如两台 “Chrome · macOS” 显示为 “Chrome · macOS (2)”。
 * @param {DeviceGrant[]} grants @param {string} name @param {string} peer
 */
function distinctName(grants, name, peer) {
  const taken = new Set(
    grants
      .filter((value) => value.devicePeerId !== peer && value.status !== "revoked")
      .map((value) => value.displayName),
  );
  if (!taken.has(name)) return name;
  const base = name.slice(0, 74);
  for (let index = 2; ; index += 1) {
    const candidate = `${base} (${index})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** @param {Remote} remote @param {string} id */
async function revokeDevice(remote, id) {
  const previous = (remote.config.deviceGrants ?? []).find((value) => value.devicePeerId === id);
  if (!previous) throw new Error("设备未获授权");
  await remote.save({
    ...remote.config,
    deviceGrants: (remote.config.deviceGrants ?? []).map((value) =>
      value !== previous
        ? value
        : {
            ...previous,
            push: undefined,
            status: "revoked",
            revision: previous.revision + 1,
            revokedAt: Date.now(),
          },
    ),
  });
  remote.closePeer(id);
}

/** @param {Remote} remote @param {string} id @param {string} value */
async function renameDevice(remote, id, value) {
  const name = value.trim();
  if (!name || name.length > 80) throw new Error("设备名称需为 1 到 80 个字符");
  const previous = (remote.config.deviceGrants ?? []).find((grant) => grant.devicePeerId === id);
  if (!previous || previous.status === "revoked") throw new Error("设备未获授权");
  // 名称只用于桌面展示，不改 revision，已连接的设备不会因此断开。
  await remote.save({
    ...remote.config,
    deviceGrants: (remote.config.deviceGrants ?? []).map((grant) =>
      grant === previous ? { ...previous, displayName: name } : grant,
    ),
  });
}

/** @param {Remote} remote */
async function forgetRevoked(remote) {
  const forgotten = new Set(
    (remote.config.deviceGrants ?? [])
      .filter((grant) => grant.status === "revoked")
      .map((grant) => grant.devicePeerId),
  );
  if (!forgotten.size) return;
  await remote.save({
    ...remote.config,
    deviceGrants: (remote.config.deviceGrants ?? []).filter(
      (grant) => !forgotten.has(grant.devicePeerId),
    ),
    ...(remote.config.pushCommands
      ? {
          pushCommands: remote.config.pushCommands.filter(
            (command) => !forgotten.has(command.devicePeerId),
          ),
        }
      : {}),
  });
  for (const peer of forgotten) remote.lastSeen.delete(peer);
}

module.exports = { distinctName, forgetRevoked, renameDevice, revokeDevice };
