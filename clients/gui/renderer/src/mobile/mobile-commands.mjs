import { CommandState } from "@areal/remote-client";

/** @typedef {{text:string,configuration?:{model?:{providerId:string,modelId:string},parameters?:Record<string,unknown>,options?:Record<string,unknown>}}} ComposeIntent */
const failure = (code) => Object.assign(new Error(code), { code });
export class MobileCommands {
  constructor(client, workspace) {
    this.client = client;
    this.workspace = workspace;
    this.commands = new CommandState();
    this.configuration = new Map();
    this.outgoing = null;
    this.unsent = null;
    this.listeners = new Set();
    /** @type {{revision:number,busy:boolean,recovering:boolean,error:string|null}} */
    this.state = { revision: 0, busy: false, recovering: false, error: null };
    this.unsubscribe = client.subscribe(() => this.connectionChanged());
    this.unsubscribeWorkspace = workspace.subscribe?.(() => this.resumeUnsent());
  }
  snapshot = () => this.state;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  publish(values = {}) {
    this.state = { ...this.state, ...values, revision: this.state.revision + 1 };
    this.listeners.forEach((listener) => listener());
  }
  key(projectId, threadId = "") {
    return this.commands.key(
      this.client.snapshot().ready?.hostId ?? this.hostId,
      projectId,
      threadId,
    );
  }
  commandKey(command) {
    return this.key(
      command.projectId,
      command.method === "session.create"
        ? ""
        : command.params.threadId +
            (command.method === "turn.stop" ? `:stop:${command.params.expectedTurnId}` : ""),
    );
  }
  draft(projectId, threadId = "") {
    return this.commands.drafts.get(this.key(projectId, threadId)) ?? "";
  }
  setDraft(projectId, threadId, text) {
    this.commands.drafts.set(this.key(projectId, threadId), text);
    this.publish();
    this.resumeUnsent();
  }
  outgoingFor(projectId, threadId, turns = []) {
    const outgoing = this.outgoing;
    if (outgoing?.key !== this.key(projectId, threadId)) return null;
    if (
      outgoing.turnId &&
      turns.some(
        (turn) =>
          turn.id === outgoing.turnId &&
          turn.items?.some(
            (item) => item.type === "userMessage" || item.originalType === "userMessage",
          ),
      )
    )
      return null;
    return outgoing;
  }
  intent(projectId, threadId = "") {
    return this.configuration.get(this.key(projectId, threadId));
  }
  setIntent(projectId, threadId, value) {
    this.configuration.set(this.key(projectId, threadId), value);
    this.publish();
  }
  unresolved(projectId, threadId = "") {
    return [...this.commands.commands.values()].filter(
      (command) =>
        command.projectId === projectId &&
        (command.params.threadId ?? "") === threadId &&
        this.commands.unresolved(command),
    );
  }
  blocksSend(projectId, threadId = "") {
    const snapshot = this.workspace.state.detail?.snapshot;
    return this.unresolved(projectId, threadId).some(
      (command) =>
        command.method !== "turn.stop" ||
        !snapshot ||
        snapshot.threadId !== threadId ||
        snapshot.activeTurnId === command.params.expectedTurnId,
    );
  }
  connectionChanged() {
    const state = this.client.snapshot();
    if (state.kind === "unpaired" || state.kind === "revoked") {
      this.commands.commands.clear();
      this.commands.drafts.clear();
      this.configuration.clear();
      this.outgoing = null;
      this.unsent = null;
      this.connection = null;
      this.publish({ busy: false, recovering: false, error: null });
      return;
    }
    if (state.kind !== "connected") {
      this.connection = null;
      for (const [key, command] of this.commands.commands)
        if (command.admissionState === "pending")
          this.commands.failed(
            key,
            command,
            failure(command.dispatched ? "SUBMISSION_UNKNOWN" : "LOCAL_NOT_SENT"),
          );
      this.publish();
      this.resumeUnsent();
      return;
    }
    if (this.connection === this.client.connection) return;
    this.connection = this.client.connection;
    this.hostId = state.ready.hostId;
    this.recoverConnection();
  }
  recoverConnection() {
    if (
      this.client.snapshot().kind !== "connected" ||
      this.connection !== this.client.connection ||
      this.state.busy ||
      this.state.recovering
    )
      return;
    if (this.recoveredConnection !== this.client.connection) {
      this.recoveredConnection = this.client.connection;
      void this.recover();
    } else this.resumeUnsent();
  }
  resumeUnsent() {
    const attempt = this.unsent;
    if (!attempt) return;
    const state = this.client.snapshot();
    const view = this.workspace.state;
    const ready = state.ready;
    const token = this.client.identities.current();
    if (
      view.page !== attempt.page ||
      state.grantChanged ||
      (ready &&
        (ready.hostId !== attempt.hostId ||
          ready.grantRevision !== attempt.grantRevision ||
          !ready.capabilities?.includes("submit") ||
          token?.instance !== attempt.instance)) ||
      this.draft(attempt.page.projectId, attempt.page.threadId) !== attempt.text
    ) {
      this.unsent = null;
      this.outgoing = null;
      this.publish();
      return;
    }
    if (
      state.kind !== "connected" ||
      this.state.busy ||
      this.state.recovering ||
      this.recoveredConnection !== this.client.connection ||
      view.loading
    )
      return;
    if (view.error) {
      this.unsent = null;
      this.outgoing = null;
      this.publish({ error: "LOCAL_NOT_SENT" });
      return;
    }
    if (
      view.stale ||
      view.detail?.projectId !== attempt.page.projectId ||
      view.detail?.snapshot?.threadId !== attempt.page.threadId
    )
      return;
    this.unsent = null;
    if (this.blocksSend(attempt.page.projectId, attempt.page.threadId)) {
      this.outgoing = null;
      this.publish();
      return;
    }
    void this.send();
  }
  finish() {
    this.publish({ busy: false });
    this.recoverConnection();
  }
  async recover() {
    const token = this.client.identities.current();
    if (token?.mode !== "remembered") {
      this.resumeUnsent();
      return;
    }
    this.publish({ recovering: true });
    try {
      const locators = await this.client.identities.locators(token);
      for (const locator of locators) {
        if (this.client.identities.current() !== token) return;
        const key = this.commandKey(locator),
          existing = this.commands.commands.get(key);
        if (existing?.commandId === locator.commandId && !this.commands.unresolved(existing)) {
          await this.client.identities.settleLocator(
            token,
            locator.commandId,
            existing.admissionState,
          );
          continue;
        }
        if (existing?.commandId !== locator.commandId) this.commands.commands.set(key, locator);
        await this.query(this.commands.commands.get(key));
      }
    } catch {
      this.publish({ error: "RECOVERY_FAILED" });
    } finally {
      this.publish({ recovering: false });
      this.recoverConnection();
    }
  }
  async receive(key, command, value, token) {
    if (this.commands.commands.get(key) !== command || this.client.identities.current() !== token)
      return undefined;
    if (value.commandId !== command.commandId) throw failure("RESYNC_REQUIRED");
    try {
      await this.client.identities.settleLocator(token, command.commandId, value.admissionState);
    } catch {
      throw failure("SUBMISSION_UNKNOWN");
    }
    this.commands.receive(key, command, value);
    if (value.admissionState === "rejected")
      this.publish({ error: value.error?.code ?? "COMMAND_REJECTED" });
    this.publish();
    return value;
  }
  async readReceipt(command, token) {
    const value = await this.client.request({
      method: "command.read",
      context: { projectId: command.projectId },
      params: { commandId: command.commandId },
    });
    return this.receive(this.commandKey(command), command, value, token);
  }
  async confirmReceipt(command, connection, token) {
    for (const delay of [0, 400, 900]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (
        this.client.connection !== connection ||
        this.client.identities.current() !== token ||
        this.client.snapshot().kind !== "connected" ||
        !this.commands.unresolved(command)
      )
        return;
      try {
        const receipt = await this.readReceipt(command, token);
        if (!receipt || !this.commands.unresolved(receipt)) return receipt;
      } catch {
        // 连不上时保留原命令，等重连或用户核对；这里从不重发。
        return;
      }
    }
  }
  async issue(method, projectId, params, serviceGeneration) {
    const page = this.workspace.state.page,
      connection = this.client.connection;
    const token = await this.client.remember().catch((error) => {
      if (this.client.connection !== connection || this.workspace.state.page !== page)
        throw failure("LOCAL_NOT_SENT");
      throw error;
    });
    if (this.workspace.state.page !== page || this.client.connection !== connection)
      throw failure("LOCAL_NOT_SENT");
    const ready = this.client.snapshot().ready;
    if (!connection || !ready) throw failure("LOCAL_NOT_SENT");
    const key = this.commandKey({ method, projectId, params });
    const command = this.commands.begin(key, method, params);
    Object.assign(command, { projectId, hostId: ready.hostId, dispatched: false });
    this.publish();
    let persisted = false;
    try {
      await this.client.identities.persistLocator(token, command);
      persisted = true;
      if (
        this.client.identities.current() !== token ||
        this.client.connection !== connection ||
        this.workspace.state.page !== page ||
        this.workspace.state.stale ||
        (method === "session.send" &&
          this.workspace.state.detail?.serviceGeneration !== serviceGeneration)
      )
        throw failure("LOCAL_NOT_SENT");
      command.dispatched = true;
      const value = await this.client.request({
        method,
        commandId: command.commandId,
        context: {
          projectId,
          serviceGeneration,
          gatewayGeneration: ready.gatewayGeneration,
          grantRevision: ready.grantRevision,
        },
        params,
      });
      const receipt = await this.receive(key, command, value, token);
      if (receipt && this.commands.unresolved(receipt))
        return (await this.confirmReceipt(command, connection, token)) ?? receipt;
      return receipt;
    } catch (error) {
      if (error.code === "BROWSER_COMMAND_PENDING" && error.locator) {
        this.commands.commands.set(key, error.locator);
        this.publish();
        return undefined;
      }
      const rejected = command.dispatched ? error : failure("LOCAL_NOT_SENT");
      if (!command.dispatched) {
        // 即使旧令牌无法清除本机定位信息，也能确定传输层从未收到这条命令。
        this.commands.failed(key, command, rejected);
        if (persisted)
          await this.client.identities
            .settleLocator(token, command.commandId, "rejected")
            .catch(() => {});
        throw rejected;
      }
      if (persisted && !this.commands.failureIsUnknown(rejected)) {
        try {
          await this.client.identities.settleLocator(token, command.commandId, "rejected");
        } catch {
          this.commands.failed(key, command, failure("SUBMISSION_UNKNOWN"));
          this.publish();
          throw failure("SUBMISSION_UNKNOWN");
        }
      }
      this.commands.failed(key, command, rejected);
      this.publish();
      if (command.dispatched && method === "session.send" && this.commands.unresolved(command)) {
        const receipt = await this.confirmReceipt(command, connection, token);
        if (receipt) return receipt;
      }
      throw rejected;
    }
  }
  migrateDraft(projectId, threadId) {
    const old = this.key(projectId),
      next = this.key(projectId, threadId);
    if (this.commands.drafts.has(old)) {
      this.commands.drafts.set(next, this.commands.drafts.get(old));
      this.commands.drafts.delete(old);
    }
    if (this.configuration.has(old)) {
      this.configuration.set(next, this.configuration.get(old));
      this.configuration.delete(old);
    }
  }
  async query(command) {
    if (
      !command ||
      !this.commands.unresolved(command) ||
      this.client.snapshot().kind !== "connected"
    )
      return;
    const token = this.client.identities.current(),
      key = this.commandKey(command);
    try {
      const received = await this.readReceipt(command, token);
      if (received?.admissionState !== "accepted") return;
      this.publish({ error: null });
      if (command.method === "session.create") {
        this.migrateDraft(command.projectId, received.threadId);
        if (
          this.workspace.state.page.kind === "new" &&
          this.workspace.state.page.projectId === command.projectId
        )
          await this.workspace.navigate({
            kind: "session",
            projectId: command.projectId,
            threadId: received.threadId,
          });
      } else {
        if (command.method === "session.control" && command.params.operation === "configure")
          this.configuration.delete(this.key(command.projectId, command.params.threadId));
        await this.workspace.refresh();
      }
    } catch {
      this.commands.failed(key, command, failure("SUBMISSION_UNKNOWN"));
    } finally {
      this.publish();
    }
  }
  async configureIntent(projectId, threadId, intent) {
    const detail = this.workspace.state.detail,
      snapshot = detail?.snapshot;
    if (snapshot?.threadId !== threadId || snapshot.activeTurnId)
      throw failure("CONFIGURATION_UNAVAILABLE");
    if (intent.model) {
      const model = snapshot.models.find(
        (value) =>
          value.providerId === intent.model.providerId && value.modelId === intent.model.modelId,
      );
      if (
        !model ||
        model.available === false ||
        (intent.parameters?.reasoningEffort &&
          intent.parameters.reasoningEffort !== "default" &&
          (model.capabilities?.reasoningEffortOptions !== undefined ||
            model.reasoningEffortOptions?.length) &&
          !model.reasoningEffortOptions?.includes(intent.parameters.reasoningEffort))
      )
        throw failure("CONFIGURATION_UNAVAILABLE");
    }
    const preset = intent.options?.permissionPreset;
    if (
      preset &&
      (!snapshot.configuration?.permissions ||
        snapshot.configuration?.profile?.readOnly ||
        (preset === "fullAccess" && !snapshot.configuration.permissions.fullAccessAvailable))
    )
      throw failure("CONFIGURATION_UNAVAILABLE");
    const value = await this.issue(
      "session.control",
      projectId,
      {
        threadId,
        operation: "configure",
        values: intent,
        expectedRevision: snapshot.configRevision,
      },
      detail.serviceGeneration,
    );
    if (value?.admissionState !== "accepted") return null;
    this.configuration.delete(this.key(projectId, threadId));
    // Host 只在 Core 返回 expectedRevision + 1 时结算配置成功。
    return { revision: snapshot.configRevision + 1, serviceGeneration: detail.serviceGeneration };
  }
  async send() {
    if (
      this.state.busy ||
      this.state.recovering ||
      this.workspace.state.stale ||
      this.client.snapshot().kind !== "connected"
    )
      return;
    const page = this.workspace.state.page;
    if (!["new", "session"].includes(page.kind)) return;
    const connection = this.client.connection;
    const ready = this.client.snapshot().ready;
    const instance = this.client.identities.current()?.instance;
    const generation = this.workspace.state.detail?.serviceGeneration;
    let threadId = page.kind === "session" ? page.threadId : "";
    const projectId = page.projectId;
    const text = this.draft(projectId, threadId);
    const intent = structuredClone(this.intent(projectId, threadId));
    if (!text.trim() || this.blocksSend(projectId, threadId)) return;
    const outgoing = { key: this.key(projectId, threadId), text, turnId: null };
    this.outgoing = outgoing;
    this.publish({ busy: true, error: null });
    try {
      if (!threadId) {
        const catalog = this.workspace.state.catalog;
        if (!catalog) throw failure("CONFIGURATION_UNAVAILABLE");
        const serviceGeneration = await this.workspace.activate(projectId);
        if (this.workspace.state.page !== page || this.client.connection !== connection)
          throw failure("LOCAL_NOT_SENT");
        // 配对设备创建后按实时配置版本提交设置；桌面创建选项在 Host 上仅限本机。
        const result = await this.issue("session.create", projectId, {}, serviceGeneration);
        if (result?.admissionState !== "accepted") return;
        threadId = result.threadId;
        this.migrateDraft(projectId, threadId);
        if (this.workspace.state.page !== page || this.client.connection !== connection)
          throw failure("LOCAL_NOT_SENT");
        outgoing.key = this.key(projectId, threadId);
        await this.workspace.navigate({ kind: "session", projectId, threadId });
      }
      const target = this.workspace.state.page;
      if (
        target.kind !== "session" ||
        target.projectId !== projectId ||
        target.threadId !== threadId ||
        this.client.connection !== connection
      )
        throw failure("LOCAL_NOT_SENT");
      const configured = intent ? await this.configureIntent(projectId, threadId, intent) : null;
      if (intent && !configured) return;
      if (this.client.connection !== connection || this.workspace.state.page !== target)
        throw failure("LOCAL_NOT_SENT");
      const detail = this.workspace.state.detail,
        snapshot = detail?.snapshot;
      if (
        detail?.projectId !== projectId ||
        snapshot?.threadId !== threadId ||
        this.workspace.state.stale ||
        !Number.isSafeInteger(snapshot.configRevision) ||
        (configured && configured.serviceGeneration !== detail.serviceGeneration)
      )
        throw failure("LOCAL_NOT_SENT");
      if (snapshot.ownership.kind !== "ordinary") throw failure("TASK_CONTROL_REQUIRED");
      const receipt = await this.issue(
        "session.send",
        projectId,
        {
          threadId,
          text,
          expectedConfigRevision: configured?.revision ?? snapshot.configRevision,
          ...(snapshot.activeTurnId
            ? { enqueue: true, expectedTurnId: snapshot.activeTurnId }
            : {}),
        },
        detail.serviceGeneration,
      );
      if (receipt?.admissionState === "accepted" && receipt.turnId)
        outgoing.turnId = receipt.turnId;
    } catch (error) {
      const current = this.workspace.state.page;
      if (
        error.code === "LOCAL_NOT_SENT" &&
        current.kind === "session" &&
        current.projectId === projectId &&
        current.threadId === threadId &&
        (page.kind === "new" || current === page) &&
        (connection !== this.client.connection ||
          this.workspace.state.stale ||
          (generation && generation !== this.workspace.state.detail?.serviceGeneration))
      ) {
        this.unsent = {
          page: current,
          text,
          hostId: ready.hostId,
          grantRevision: ready.grantRevision,
          instance,
        };
        outgoing.reconnecting = true;
      } else this.publish({ error: error.code ?? "COMMAND_FAILED" });
    } finally {
      if (
        this.outgoing === outgoing &&
        (!outgoing.turnId || !this.outgoingFor(projectId, threadId, this.workspace.state.turns)) &&
        !this.unsent
      )
        this.outgoing = null;
      this.finish();
    }
  }
  async configure(projectId, threadId, intent) {
    if (this.workspace.state.stale || this.client.snapshot().kind !== "connected") return false;
    if (this.state.busy || this.state.recovering || this.blocksSend(projectId, threadId))
      return false;
    this.setIntent(projectId, threadId, intent);
    if (!threadId) return true;
    this.publish({ busy: true, error: null });
    try {
      const configured = await this.configureIntent(projectId, threadId, intent);
      if (!configured) return false;
      await this.workspace.refresh();
      return true;
    } catch (error) {
      this.publish({ error: error.code ?? "COMMAND_FAILED" });
      return false;
    } finally {
      this.finish();
    }
  }
  async stop() {
    const detail = this.workspace.state.detail,
      snapshot = detail?.snapshot;
    if (
      !snapshot?.activeTurnId ||
      this.workspace.state.stale ||
      this.client.snapshot().kind !== "connected" ||
      this.state.busy ||
      this.unresolved(detail.projectId, snapshot.threadId).some(
        (command) =>
          command.method === "turn.stop" && command.params.expectedTurnId === snapshot.activeTurnId,
      )
    )
      return;
    this.publish({ busy: true, error: null });
    try {
      await this.issue(
        "turn.stop",
        detail.projectId,
        { threadId: snapshot.threadId, expectedTurnId: snapshot.activeTurnId },
        detail.serviceGeneration,
      );
    } catch (error) {
      this.publish({ error: error.code ?? "COMMAND_FAILED" });
    } finally {
      this.finish();
    }
  }
  dispose() {
    this.unsubscribe();
    this.unsubscribeWorkspace?.();
  }
}
