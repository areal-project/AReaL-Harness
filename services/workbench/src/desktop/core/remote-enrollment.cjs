// @ts-check
const { request: httpsRequest } = require("node:https");
const { createHash } = require("node:crypto");
const { desktopTlsOptions } = require("./desktop-network.cjs");
const { enrollmentFailureMessage } = require("./remote-config.cjs");
/** @param {string} code @param {string} message */
const pairingError = (code, message) => Object.assign(new Error(message), { code });
/** @param {string} relay @param {string} code @returns {Promise<{room:string,capability:string}>} */
async function enrollRelay(relay, code) {
  return await new Promise((resolve, reject) => {
    const body = JSON.stringify({ code: code });
    const req = httpsRequest(
      `${relay}/enroll`,
      {
        ...desktopTlsOptions(),
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          if ((size += chunk.length) > 4096) req.destroy();
          else chunks.push(chunk);
        });
        response.on("error", () =>
          reject(pairingError("enrollment-failed", "Relay 登记失败，请检查 HTTPS 和登记码")),
        );
        response.on("end", () => {
          try {
            /** @type {unknown} */
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if (
              response.statusCode !== 201 ||
              !value ||
              typeof value !== "object" ||
              !("capability" in value) ||
              typeof value.capability !== "string" ||
              !("room" in value) ||
              typeof value.room !== "string" ||
              !/^[A-Za-z0-9_-]{43}$/.test(value.capability) ||
              createHash("sha256").update(value.capability).digest("hex") !== value.room
            )
              throw new Error();
            resolve({ room: value.room, capability: value.capability });
          } catch {
            reject(pairingError("enrollment-failed", "Relay 登记失败，请检查 HTTPS 和登记码"));
          }
        });
      },
    );
    const deadline = setTimeout(() => req.destroy(), 15000);
    req.once("close", () => clearTimeout(deadline));
    req.once("error", (error) => {
      reject(pairingError("enrollment-failed", enrollmentFailureMessage(error)));
    });
    req.end(body);
  });
}
module.exports = { enrollRelay, pairingError };
