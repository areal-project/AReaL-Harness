"use strict";
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { parseRemoteConfig } = require("../app/src/core/remote-config.cjs");

function attachRemoteHostFixture(remote, encryption) {
  let connected = true;
  remote.storage = {
    async init() {
      connected = true;
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
    async drained() {},
    close() {
      connected = false;
    },
  };
}
module.exports = { attachRemoteHostFixture };
