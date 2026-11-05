// @ts-check
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const execute = promisify(execFile);
/** @param {string} value */
const quote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** @typedef {{target:string,port:number,ownerId:string,address:string,room:string,removeData?:boolean}} DeploymentTarget */
/** @typedef {{ownerId:string,active:boolean,installed:boolean,version?:string,absent?:boolean,dataRetained?:boolean,room?:string,roomActive?:boolean,address?:string}} DeploymentReceipt */
/** @param {DeploymentTarget} input */
function parseTarget(input) {
  if (
    !input ||
    typeof input.target !== "string" ||
    !/^[a-z_][a-z0-9_-]{0,31}@[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(input.target) ||
    input.target.includes("..")
  )
    throw new Error("INVALID_SSH_TARGET");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
    throw new Error("INVALID_SSH_PORT");
  if (!/^[a-f0-9]{32}$/.test(input.ownerId)) throw new Error("INVALID_RELAY_OWNER");
  const origin = new URL(input.address);
  if (
    origin.origin !== input.address ||
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    !/^https:\/\/[a-zA-Z0-9.:-]+$/.test(input.address)
  )
    throw new Error("INVALID_RELAY_ADDRESS");
  if (!/^[a-f0-9]{64}$/.test(input.room)) throw new Error("INVALID_ROOM");
  return input;
}

class RelayDeployment {
  /** @param {{home:string,bundleDir:string}} options */
  constructor({ home, bundleDir }) {
    this.home = home;
    this.bundleDir = bundleDir;
    /** @type {Set<import("node:child_process").ChildProcessWithoutNullStreams>} */
    this.children = new Set();
    this.closed = false;
  }
  /** @param {"deploy"|"upgrade"|"inspect"|"remove"} op @param {DeploymentTarget} input @returns {Promise<DeploymentReceipt>} */
  async run(op, input) {
    if (this.closed) throw new Error("RELAY_DEPLOYMENT_CLOSED");
    const value = parseTarget(input);
    const script = await readFile(join(this.bundleDir, "deploy/managed-install.sh"));
    const archive =
      op === "deploy" || op === "upgrade"
        ? (
            await execute("tar", ["-cf", "-", "-C", this.bundleDir, "."], {
              encoding: "buffer",
              maxBuffer: 128 * 1024 * 1024,
            })
          ).stdout
        : Buffer.alloc(0);
    const version = archive.length ? createHash("sha256").update(archive).digest("hex") : "-";
    const args = [
      op,
      value.ownerId,
      version,
      value.address,
      value.room,
      String(input.removeData === true),
    ]
      .map(quote)
      .join(" ");
    const body = `set -eu; stage=$(mktemp -d); trap 'rm -rf -- "$stage"' EXIT; printf %s ${quote(script.toString("base64"))} | base64 -d > "$stage/install.sh"; bash "$stage/install.sh" ${args}`;
    const command = `${value.target.startsWith("root@") ? "" : "sudo -n "}bash -c ${quote(body)}`;
    if (this.closed) throw new Error("RELAY_DEPLOYMENT_CLOSED");
    /** @type {DeploymentReceipt} */
    const output = await new Promise((resolve, reject) => {
      const child = spawn(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "ConnectTimeout=15",
          "-p",
          String(value.port),
          "--",
          value.target,
          command,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      this.children.add(child);
      if (this.closed) child.kill();
      child.once("close", () => this.children.delete(child));
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      let overflow = false;
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 65536) chunks.push(chunk);
        else {
          overflow = true;
          child.kill();
        }
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      /** @param {unknown} [cause] */
      const fail = (cause) =>
        reject(
          Object.assign(
            new Error(op === "inspect" ? "SSH_INSPECT_FAILED" : "SSH_MUTATION_UNKNOWN"),
            { code: op === "inspect" ? "SSH_INSPECT_FAILED" : "SSH_MUTATION_UNKNOWN", cause },
          ),
        );
      child.once("error", fail);
      child.once("close", (code) => {
        if (code !== 0 || overflow) return fail();
        try {
          const result = JSON.parse(
            Buffer.concat(chunks).toString().trim().split("\n").at(-1) ?? "",
          );
          if (
            result.ownerId !== value.ownerId ||
            typeof result.active !== "boolean" ||
            typeof result.installed !== "boolean" ||
            (result.version !== undefined && !/^[a-f0-9]{64}$/.test(result.version))
          )
            throw new Error("INVALID_RECEIPT");
          if (
            result.absent === true &&
            (result.installed || result.active || result.dataRetained !== false)
          )
            throw new Error("INVALID_ABSENCE_RECEIPT");
          resolve(result);
        } catch (error) {
          fail(error);
        }
      });
      child.stdin.end(archive);
    });
    return output;
  }
  async close() {
    this.closed = true;
    await Promise.all(
      [...this.children].map(
        (child) =>
          new Promise((resolve) => {
            child.once("close", () => resolve(undefined));
            child.kill();
          }),
      ),
    );
  }
  /** @param {DeploymentTarget} input */
  deploy(input) {
    return this.run("deploy", input);
  }
  /** @param {DeploymentTarget} input */
  upgrade(input) {
    return this.run("upgrade", input);
  }
  /** @param {DeploymentTarget} input */
  inspect(input) {
    return this.run("inspect", input);
  }
  /** @param {DeploymentTarget} input */
  remove(input) {
    if (typeof input.removeData !== "boolean") throw new Error("REMOVE_DATA_REQUIRED");
    return this.run("remove", input);
  }
}
module.exports = { RelayDeployment, parseTarget };
