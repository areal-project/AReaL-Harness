"use strict";
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { parseRemoteConfig } = require("@areal/workbench-service/desktop/core/remote-config.cjs");

function attachRemoteHostFixture(remote, encryption) {
  let connected = true;
  let rustWire;
  remote.storage = {
    async init() {
      connected = true;
      if (process.env.AREAL_REMOTE_WIRE === "rust") {
        const { rustWireFixture } = await import("./remote-rust-wire-fixture.mjs");
        rustWire ??= rustWireFixture();
        remote.crypto = { ...remote.crypto, secureChannel: rustWire.secureChannel };
      }
      try {
        const saved = JSON.parse(
          await readFile(join(remote.backend.home, "remote-host-fixture.json"), "utf8"),
        );
        return parseRemoteConfig(
          JSON.parse(encryption.decryptString(Buffer.from(saved.encrypted, "base64"))),
        );
      } catch (error) {
        if (error.code === "ENOENT") return { enabled: false, devices: [] };
        throw error;
      }
    },
    available: () => connected,
    refresh: async () => remote.config,
    async replace(config) {
      await remote.backend.save("remote-host-fixture.json", {
        encrypted: encryption.encryptString(JSON.stringify(config)).toString("base64"),
      });
      return config;
    },
    async drained() {
      await rustWire?.drained();
    },
    close() {
      connected = false;
      rustWire?.close();
    },
  };
}
module.exports = { attachRemoteHostFixture };
