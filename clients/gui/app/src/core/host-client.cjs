// @ts-check
"use strict";
const { randomUUID, createHash, createHmac } = require("node:crypto");
const { constants } = require("node:fs");
const { open, lstat, realpath } = require("node:fs/promises");
const { connect } = require("node:net");
const { spawn } = require("node:child_process");
const { mkdir } = require("node:fs/promises");
const { join, isAbsolute, relative, sep } = require("node:path");
const MAX_FRAME = 1024 * 1024;

/** @typedef {{kind:"providerCredential",sourceId:string,reference:string}|{kind:"subscriptionAccount",sourceId:string,providerId:string}|{kind:"subscriptionTransport",sourceId:string}} VaultSlot */
/** @typedef {{projectId:string,state:"observed",activeTasks:number,activeTurns:number,activeGoals:number,pendingQueueItems:number,idleAllowed:boolean}|{projectId:string,state:"unavailable"}} ProjectActivity */
/** @typedef {{complete:boolean,projects:ProjectActivity[],totalActiveTasks:number}} HostActivity */

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

/** @param {string} home */
async function prepareHostHome(home) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const directory = await open(
    home,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await directory.stat();
    if (!stat.isDirectory() || stat.uid !== process.getuid?.())
      throw new Error("Host home must be owned by the current user");
    const mode = stat.mode & 0o7777;
    if (mode === 0o755) {
      await directory.chmod(0o700);
      console.warn(`Restricted legacy Host home permissions to 700: ${home}`);
    } else if ((mode & 0o7077) !== 0) {
      throw new Error("Host home must be private or legacy mode 755");
    }
    const after = await directory.stat();
    const named = await lstat(home);
    if (
      !named.isDirectory() ||
      after.uid !== process.getuid?.() ||
      (after.mode & 0o7077) !== 0 ||
      after.dev !== named.dev ||
      after.ino !== named.ino
    )
      throw new Error("Host home changed during initialization");
  } finally {
    await directory.close();
  }
}

// 断连不重放写入。调用者必须凭原 requestId 查询持久回执。
class HostClient {
  #intentKey = "";
  /** @type {{id:string,generation:string,sequence:number,onState:(state:unknown)=>void}|null} */
  #gatewaySubscription = null;
  constructor() {
    /** @type {Map<string,{resolve:(value:any)=>void,reject:(error:Error)=>void}>} */
    this.pending = new Map();
    /** @type {import('node:net').Socket|undefined} */
    this.socket = undefined;
    this.bytes = Buffer.alloc(0);
    this.generation = "";
    this.hostId = "";
    /** @type {string[]} */
    this.capabilities = [];
    this.home = "";
    /** @type {Map<string,HostJournal>} */
    this.journals = new Map();
  }
  /** @param {string} home */
  async connect(home) {
    if (this.socket) throw new Error("Host client already connected");
    const homeStat = await lstat(home);
    if (
      !homeStat.isDirectory() ||
      homeStat.uid !== process.getuid?.() ||
      (homeStat.mode & 0o077) !== 0
    )
      throw new Error("Host home must be private and owned by this user");
    const canonical = await realpath(home);
    const hostStat = await lstat(join(canonical, "host"));
    if (
      !hostStat.isDirectory() ||
      hostStat.uid !== process.getuid?.() ||
      (hostStat.mode & 0o077) !== 0
    )
      throw new Error("Host discovery directory must be private and owned by this user");
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
    this.hostId = hello.hostId;
    this.generation = hello.generation;
    this.capabilities = hello.capabilities;
    this.#intentKey = token;
    return hello;
  }
  /** @param {string} home @param {string} binary */
  async connectOrStart(home, binary) {
    await prepareHostHome(home);
    try {
      return await this.connect(home);
    } catch {
      this.close();
    }
    const log = await open(
      join(home, "host.log"),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    const logStat = await log.stat();
    if (!logStat.isFile() || logStat.uid !== process.getuid?.() || (logStat.mode & 0o077) !== 0) {
      await log.close();
      throw new Error("Host log must be private and owned by this user");
    }
    const child = spawn(binary, ["host", "run"], {
      env: {
        ...Object.fromEntries(
          ["HOME", "PATH", "TMPDIR", "LANG"].flatMap((key) =>
            process.env[key] ? [[key, process.env[key]]] : [],
          ),
        ),
        AREAL_HARNESS_HOME: home,
        AREAL_HARNESS_SERVICE_HOME: home,
      },
      detached: true,
      stdio: ["ignore", "ignore", log.fd],
      windowsHide: true,
    });
    let failure;
    child.on("error", (error) => {
      failure = error;
    });
    child.unref();
    await log.close();
    const deadline = Date.now() + 15000;
    for (;;) {
      if (failure) throw failure;
      try {
        return await this.connect(home);
      } catch (error) {
        this.close();
        if (Date.now() >= deadline) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  status() {
    return this.request("host.status", {});
  }
  /** @returns {Promise<HostActivity>} */
  activity() {
    this.requireCapability("activity");
    return this.request("host.activity", {});
  }
  /** @param {string} requestId @param {string} generation @param {'ifIdle'|'cancel'} strategy */
  stop(requestId, generation, strategy) {
    this.requireCapability("stopOperations");
    return this.request("host.stop", { requestId, expectedGeneration: generation, strategy });
  }
  /** @param {string} requestId @param {string} projectId @param {unknown} launchInputs @param {Record<string,string>} [credentials] @param {boolean} [resumeScheduling] */
  ensureProject(requestId, projectId, launchInputs, credentials, resumeScheduling = false) {
    this.requireCapability("scheduledActivation");
    return this.request("project.ensure", {
      requestId,
      expectedGeneration: this.generation,
      projectId,
      ...(launchInputs ? { launchInputs } : {}),
      ...(credentials ? { credentials } : {}),
      ...(resumeScheduling ? { resumeScheduling: true } : {}),
      noAutoRestart: true,
    });
  }
  /** @param {string} requestId @param {string} projectId @param {string} serviceGeneration @param {'ifIdle'|'cancel'} strategy @param {boolean} [suppressScheduling] */
  stopProject(requestId, projectId, serviceGeneration, strategy, suppressScheduling = true) {
    return this.request("project.stop", {
      requestId,
      expectedGeneration: this.generation,
      projectId,
      serviceGeneration,
      strategy,
      ...(suppressScheduling ? {} : { suppressScheduling: false }),
    });
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
        if (response.version !== 1) throw new Error("Invalid Host response");
        if (response.method === "remote.gateway.stateChanged") {
          this.gatewayState(response.params, false);
          continue;
        }
        if (typeof response.id !== "string") throw new Error("Invalid Host response");
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
    this.#intentKey = "";
    this.#gatewaySubscription = null;
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
          if (method === "remote.gateway.subscribe") {
            try {
              this.gatewayState(value, true);
            } catch (error) {
              const failure =
                error instanceof Error ? error : new Error("Invalid Gateway snapshot");
              reject(failure);
              this.fail(failure);
              return;
            }
          }
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
  /** @param {string} sourceId @param {(state:unknown)=>void} onState */
  async subscribeGateway(sourceId, onState) {
    this.requireCapability("remoteGatewayV1");
    if (this.#gatewaySubscription) throw new Error("Gateway subscription already exists");
    const subscription = {
      id: "",
      generation: this.generation,
      sequence: 0,
      onState,
    };
    this.#gatewaySubscription = subscription;
    try {
      await this.request("remote.gateway.subscribe", { sourceId });
    } catch (error) {
      if (this.#gatewaySubscription === subscription) this.#gatewaySubscription = null;
      throw error;
    }
  }
  /** @param {unknown} value @param {boolean} initial */
  gatewayState(value, initial) {
    const subscription = this.#gatewaySubscription;
    if (
      !subscription ||
      !value ||
      typeof value !== "object" ||
      !("subscriptionId" in value) ||
      typeof value.subscriptionId !== "string" ||
      !value.subscriptionId ||
      !("generation" in value) ||
      value.generation !== subscription.generation ||
      !("sequence" in value) ||
      typeof value.sequence !== "number" ||
      !Number.isSafeInteger(value.sequence) ||
      !("state" in value) ||
      (initial
        ? subscription.id !== "" || value.sequence !== 0
        : value.subscriptionId !== subscription.id || value.sequence !== subscription.sequence + 1)
    )
      throw new Error("Gateway subscription identity or sequence changed");
    subscription.onState(value.state);
    subscription.id = value.subscriptionId;
    subscription.sequence = value.sequence;
  }
  /** @param {string} method @param {string} sourceId @param {string} requestId @param {string} canonicalJson */
  intentDigest(method, sourceId, requestId, canonicalJson) {
    if (!this.#intentKey || !this.socket || this.socket.destroyed)
      throw new Error("Host is disconnected");
    return createHmac("sha256", this.#intentKey)
      .update(JSON.stringify(["areal.host.intent.v1", method, sourceId, requestId]))
      .update("\0")
      .update(canonicalJson)
      .digest("hex");
  }
  /** @param {unknown} source */
  attachSource(source) {
    this.requireCapability("guiImport");
    return this.request("gui.attachSource", { source });
  }
  /** @param {import('./gui-source.cjs').GuiSource} source */
  sourceState(source) {
    this.requireCapability("guiImport");
    return this.request("gui.source", { source });
  }
  listProjects() {
    this.requireCapability("projects");
    return this.request("projects.list", {});
  }
  /** @param {string} requestId @param {{projectId:string,workspace:string,dataDir:string,source:{kind:'gui',profile:string,legacyProjectId:string}|{kind:'cli'},defaultBinding:boolean}} registration */
  registerProject(requestId, registration) {
    this.requireCapability("projects");
    return this.request("projects.register", {
      requestId,
      expectedGeneration: this.generation,
      registration,
    });
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
  /** @param {string} requestId @param {string} migrationId */
  retirementPrepare(requestId, migrationId) {
    return this.request("gui.retirementPrepare", {
      requestId,
      migrationId,
      expectedGeneration: this.generation,
    });
  }
  /** @param {string} requestId @param {string} migrationId @param {string} planId */
  retirementConfirm(requestId, migrationId, planId) {
    return this.request("gui.retirementConfirm", {
      requestId,
      migrationId,
      planId,
      expectedGeneration: this.generation,
    });
  }
  /** @param {string} migrationId */
  retirementStatus(migrationId) {
    return this.request("gui.retirementStatus", { migrationId });
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
  /** @param {VaultSlot} slot @param {{interactionAllowed?:boolean}} [options] */
  vaultRead(slot, options = {}) {
    this.requireCapability("credentialVault");
    if (options.interactionAllowed === false) {
      try {
        this.requireCapability("credentialVaultNoninteractiveV1");
      } catch {
        return Promise.reject(
          Object.assign(new Error("Host 需要升级后才能在后台读取凭据"), {
            code: "storageLocked",
          }),
        );
      }
    }
    return this.request("vault.read", { slot, ...options });
  }
  /** @param {string} requestId @param {VaultSlot} slot @param {number} expectedRevision @param {unknown} value */
  async vaultReplace(requestId, slot, expectedRevision, value) {
    this.requireCapability("credentialVault");
    try {
      return await this.request("vault.replace", {
        requestId,
        expectedGeneration: this.generation,
        slot,
        expectedRevision,
        value,
      });
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error("Host vault write failed"), {
        requestId,
        operation: "vault.replace",
      });
    }
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
    this.bytes = Buffer.alloc(0);
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
