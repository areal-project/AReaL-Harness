// @ts-check
"use strict";
const { randomUUID, createHash } = require("node:crypto");
const { constants } = require("node:fs");
const { open, lstat, realpath } = require("node:fs/promises");
const { connect } = require("node:net");
const { join, isAbsolute, relative, sep } = require("node:path");
const MAX_FRAME = 1024 * 1024;

/** @param {string} path */
async function privateJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("Host discovery file must be private and owned by this user");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}

// 断连不重放写入。调用者必须凭原 requestId 查询持久回执。
class HostClient {
  constructor() {
    /** @type {Map<string,{resolve:(value:any)=>void,reject:(error:Error)=>void}>} */
    this.pending = new Map();
    /** @type {import('node:net').Socket|undefined} */
    this.socket = undefined;
    this.bytes = Buffer.alloc(0);
    this.generation = "";
    /** @type {string[]} */
    this.capabilities = [];
    this.home = "";
    /** @type {Map<string,HostJournal>} */
    this.journals = new Map();
  }
  /** @param {string} home */
  async connect(home) {
    if (this.socket) throw new Error("Host client already connected");
    const canonical = await realpath(home);
    this.home = canonical;
    const descriptor = await privateJson(join(canonical, "host", "host.json"));
    if (
      descriptor.version !== 1 ||
      typeof descriptor.generation !== "string" ||
      typeof descriptor.hostId !== "string" ||
      !isAbsolute(descriptor.socketPath) ||
      descriptor.authFile !== join(canonical, "host", "auth.json")
    )
      throw new Error("Invalid Host descriptor");
    const token = await privateJson(descriptor.authFile);
    if (typeof token !== "string" || !token) throw new Error("Invalid Host authentication token");
    const stat = await lstat(descriptor.socketPath);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("Host socket must be private and owned by this user");
    const socket = (this.socket = connect(descriptor.socketPath));
    socket.on("data", (bytes) => this.receive(bytes));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () =>
      this.fail(new Error("Host connection closed; mutation outcome may be unknown")),
    );
    const hello = await this.request("hello", {
      protocolVersions: [1],
      capabilities: [],
      authToken: token,
    });
    if (
      hello.version !== 1 ||
      hello.hostId !== descriptor.hostId ||
      hello.generation !== descriptor.generation ||
      !Array.isArray(hello.capabilities)
    ) {
      this.close();
      throw new Error("Host identity changed during authentication");
    }
    this.generation = hello.generation;
    this.capabilities = hello.capabilities;
    return hello;
  }
  /** @param {Buffer} bytes */
  receive(bytes) {
    this.bytes = Buffer.concat([this.bytes, bytes]);
    for (;;) {
      const newline = this.bytes.indexOf(10);
      if (newline < 0) {
        if (this.bytes.length >= MAX_FRAME) this.fail(new Error("Host frame exceeds 1 MiB"));
        return;
      }
      if (newline + 1 > MAX_FRAME) return this.fail(new Error("Host frame exceeds 1 MiB"));
      const frame = this.bytes.subarray(0, newline);
      this.bytes = this.bytes.subarray(newline + 1);
      try {
        const response = JSON.parse(frame.toString("utf8"));
        if (response.version !== 1 || typeof response.id !== "string")
          throw new Error("Invalid Host response");
        const request = this.pending.get(response.id);
        if (!request) throw new Error("Unexpected Host response");
        this.pending.delete(response.id);
        if (response.error)
          request.reject(
            Object.assign(new Error(response.error.message), {
              code: response.error.code,
            }),
          );
        else if (Object.hasOwn(response, "result")) request.resolve(response.result);
        else request.reject(new Error("Host response lacks result"));
      } catch (error) {
        return this.fail(error instanceof Error ? error : new Error("Invalid Host response"));
      }
    }
  }
  /** @param {Error} error */
  fail(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.socket?.destroy();
  }
  /** @param {string} method @param {unknown} params */
  request(method, params) {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("Host is disconnected"));
    const id = randomUUID();
    const bytes = Buffer.from(JSON.stringify({ version: 1, id, method, params }) + "\n");
    if (bytes.length > MAX_FRAME) return Promise.reject(new Error("Host request exceeds 1 MiB"));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => this.fail(new Error("Host request timed out; mutation outcome may be unknown")),
        30000,
      );
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      socket.write(bytes, (error) => {
        if (error) this.fail(error);
      });
    });
  }
  /** @param {string} capability */
  requireCapability(capability) {
    if (!this.capabilities.includes(capability))
      throw new Error(`Host does not support ${capability}`);
  }
  /** @param {unknown} source */
  attachSource(source) {
    this.requireCapability("guiImport");
    return this.request("gui.attachSource", { source });
  }
  /** @param {string} requestId @param {unknown} source */
  importSource(requestId, source) {
    return this.request("gui.import", {
      requestId,
      expectedGeneration: this.generation,
      source,
    });
  }
  /** @param {string} migrationId */
  importStatus(migrationId) {
    return this.request("gui.importStatus", { migrationId });
  }
  /** @param {string} migrationId @param {{slot:unknown,sourceDigest:string}} secret @param {unknown} value */
  importSecret(migrationId, secret, value) {
    return this.request("gui.importSecret", {
      requestId: randomUUID(),
      expectedGeneration: this.generation,
      migrationId,
      slot: secret.slot,
      sourceDigest: secret.sourceDigest,
      value,
    });
  }
  /** @param {string} requestId */
  operation(requestId) {
    return this.request("host.operation", { requestId });
  }
  /** @param {string} projectId */
  journal(projectId) {
    this.requireCapability("submissionJournal");
    let journal = this.journals.get(projectId);
    if (!journal) {
      journal = new HostJournal(this, projectId);
      this.journals.set(projectId, journal);
    }
    return journal;
  }
  /** @param {string} path @param {number} flags */
  async journalFile(path, flags) {
    const actual = await realpath(path);
    const within = relative(join(this.home, "host"), actual);
    if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within))
      throw new Error("Journal slot is outside Host storage");
    const file = await open(path, flags | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      await file.close();
      throw new Error("Journal slot must be private and owned by this user");
    }
    return file;
  }
  close() {
    this.fail(new Error("Host client disconnected; mutation outcome may be unknown"));
    this.socket = undefined;
  }
}

/** @typedef {{version:1,pending:unknown[],outcomes:Record<string,unknown>}} JournalSnapshot */
class HostJournal {
  /** @param {HostClient} client @param {string} projectId */
  constructor(client, projectId) {
    this.client = client;
    this.projectId = projectId;
    /** @type {Promise<unknown>} */
    this.chain = Promise.resolve();
  }
  async read() {
    const result = await this.client.request("journal.read", { projectId: this.projectId });
    const file = await this.client.journalFile(result.snapshotPath, constants.O_RDONLY);
    let bytes;
    try {
      bytes = await file.readFile();
    } finally {
      await file.close();
    }
    if (
      bytes.length !== result.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== result.sha256
    )
      throw new Error("Host journal snapshot digest mismatch");
    /** @type {JournalSnapshot} */
    const snapshot = JSON.parse(bytes.toString("utf8"));
    if (
      snapshot.version !== 1 ||
      !Array.isArray(snapshot.pending) ||
      !snapshot.outcomes ||
      typeof snapshot.outcomes !== "object" ||
      Array.isArray(snapshot.outcomes)
    )
      throw new Error("Invalid Host journal snapshot");
    return { revision: result.revision, snapshot };
  }
  /** @param {(snapshot:JournalSnapshot)=>JournalSnapshot|Promise<JournalSnapshot>} mutate */
  change(mutate) {
    const result = this.chain.then(async () => {
      for (;;) {
        const current = await this.read();
        const next = await mutate(current.snapshot);
        const bytes = Buffer.from(JSON.stringify(next));
        const requestId = randomUUID();
        try {
          const prepared = await this.client.request("journal.prepare", {
            requestId,
            expectedGeneration: this.client.generation,
            projectId: this.projectId,
            expectedRevision: current.revision,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            byteLength: bytes.length,
          });
          if (prepared.state === "blocked" && prepared.error?.code === "revisionConflict") continue;
          if (prepared.state !== "prepared")
            throw new Error("Host journal prepare is not complete");
          const file = await this.client.journalFile(prepared.writePath, constants.O_WRONLY);
          try {
            await file.truncate(0);
            await file.writeFile(bytes);
            await file.sync();
          } finally {
            await file.close();
          }
          const receipt = await this.client.request("journal.commit", {
            requestId,
            expectedGeneration: this.client.generation,
            slotId: prepared.slotId,
          });
          if (receipt.state === "blocked" && receipt.error?.code === "revisionConflict") continue;
          if (receipt.state !== "completed") throw new Error("Host journal commit is not complete");
          return receipt;
        } catch (error) {
          throw Object.assign(
            error instanceof Error ? error : new Error("Host journal commit failed"),
            { requestId, operation: "journal.commit" },
          );
        }
      }
    });
    this.chain = result.catch(() => {});
    return result;
  }
}
module.exports = { HostClient };
