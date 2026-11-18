import { acceptSessionMessage, SessionBodyReader } from "@areal/remote-client";

export const SESSION_PAGE_SIZE = 5;

/** @typedef {import('../services.js').Data} Data */
/** @typedef {{kind:'projects'}|{kind:'new',projectId:string}|{kind:'work',projectId:string}|{kind:'session',projectId:string,threadId:string}|{kind:'task',projectId:string,taskId:string,runId:string}} MobilePage */
/** @typedef {{page:MobilePage, projects:Data[], groups:Record<string,Data>, detail:Data|null, turns:Data[], task:Data|null, catalog:Data|null, loading:boolean, error:boolean, loadingOlder:boolean, bodyError:boolean}} WorkspaceView */
export class MobileWorkspace {
  constructor(client, cache = {}) {
    this.client = client;
    this.cache = cache;
    this.listeners = new Set();
    this.bodies = new SessionBodyReader();
    this.epoch = 0;
    this.history = [];
    this.visibleTurns = [];
    /** @type {WorkspaceView} */
    this.state = {
      page: { kind: "projects" },
      projects: [],
      groups: {},
      detail: null,
      turns: [],
      task: null,
      catalog: null,
      loading: false,
      error: false,
      loadingOlder: false,
      bodyError: false,
    };
    client.onSession = (message) => this.sessionEvent(message);
    this.unsubscribe = client.subscribe(() => this.connectionChanged());
  }
  snapshot = () => this.state;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  publish(values) {
    this.state = { ...this.state, ...values };
    this.listeners.forEach((listener) => listener());
  }
  connectionChanged() {
    if (
      this.client.snapshot().kind === "connected" &&
      this.observedConnection === this.client.connection
    )
      return;
    clearInterval(this.poll);
    if (this.client.snapshot().kind !== "connected") {
      this.observedConnection = null;
      this.shell = undefined;
      this.epoch++;
      this.bodies.clear();
      this.history = [];
      this.visibleTurns = [];
      this.publish({
        ...(["unpaired", "revoked"].includes(this.client.snapshot().kind)
          ? { page: { kind: "projects" } }
          : {}),
        projects: [],
        groups: {},
        detail: null,
        turns: [],
        task: null,
        catalog: null,
        loading: false,
        loadingOlder: false,
        error: false,
      });
      return;
    }
    this.observedConnection = this.client.connection;
    const connection = this.observedConnection;
    const directory = this.readDirectory().catch(() => {});
    if (this.state.page.kind === "projects") void this.refresh();
    else
      void directory.then(() => {
        if (this.observedConnection === connection) void this.refresh();
      });
    this.poll = setInterval(() => {
      const page = this.state.page;
      if (["projects", "work"].includes(page.kind)) void this.refresh(true);
    }, 5000);
  }
  release(detail = this.state.detail, connection = this.client.connection) {
    if (detail && connection)
      void connection
        .request({
          method: "subscription.close",
          context: { projectId: detail.projectId },
          params: { subscriptionId: detail.subscriptionId },
        })
        .catch(() => {});
  }
  back() {
    const page = this.state.page;
    if (page.kind === "projects") return;
    this.navigate(
      page.kind === "work" ? { kind: "projects" } : { kind: "work", projectId: page.projectId },
    );
  }
  navigate(page) {
    this.release();
    this.epoch++;
    this.history = [];
    this.visibleTurns = [];
    this.bodies.clear();
    this.publish({
      page,
      detail: null,
      turns: [],
      task: null,
      catalog: null,
      error: false,
      loading: false,
      loadingOlder: false,
    });
    return this.refresh();
  }
  async refresh(polling = false) {
    if (this.client.snapshot().kind !== "connected" || this.state.loading) return;
    const epoch = this.epoch,
      page = this.state.page;
    this.publish({ loading: true, error: false });
    try {
      if (page.kind === "projects") {
        const projects = [];
        let cursor;
        do {
          const result = await this.client.request({
            method: "project.list",
            params: cursor ? { cursor } : {},
          });
          if (epoch !== this.epoch) return;
          projects.push(...result.projects);
          cursor = result.nextCursor;
        } while (cursor);
        this.publish({ projects });
      } else if (page.kind === "work")
        await this.work(
          page.projectId,
          polling && this.state.groups[page.projectId]?.expanded ? "refreshExpanded" : "replace",
          epoch,
        );
      else if (page.kind === "session") await this.open(page, epoch);
      else if (page.kind === "new") {
        if (!this.client.snapshot().ready.methods.includes("project.models")) {
          this.publish({
            catalog: {
              models: [],
              unsupported: true,
              serviceGeneration: this.state.groups[page.projectId]?.serviceGeneration,
            },
          });
          return;
        }
        const catalog = await this.client.request({
          method: "project.models",
          context: { projectId: page.projectId },
          params: {},
        });
        const ready = this.client.snapshot().ready;
        if (
          epoch === this.epoch &&
          catalog.projectId === page.projectId &&
          catalog.gatewayGeneration === ready.gatewayGeneration &&
          catalog.grantRevision === ready.grantRevision
        )
          this.publish({ catalog });
      } else {
        const task = await this.client.request({
          method: "task.read",
          context: { projectId: page.projectId },
          params: { taskId: page.taskId, runId: page.runId },
        });
        if (
          epoch === this.epoch &&
          task.projectId === page.projectId &&
          task.taskId === page.taskId &&
          task.runId === page.runId
        )
          this.publish({ task });
      }
    } catch {
      if (epoch === this.epoch) this.publish({ error: true });
    } finally {
      if (epoch === this.epoch) this.publish({ loading: false });
    }
  }
  async readDirectory() {
    const connection = this.client.connection;
    if (
      !this.cache.readShell ||
      !connection?.ready?.negotiatedCapabilities?.includes("gui-read-v1")
    )
      return;
    if (this.directoryRequest?.connection === connection) return this.directoryRequest.pending;
    const pending = this.client.request({ method: "shell.subscribe", params: {} }, (shell) => {
      if (
        connection !== this.client.connection ||
        shell.connectionId !== connection.ready.connectionId ||
        shell.gatewayGeneration !== connection.ready.gatewayGeneration ||
        shell.sequence !== 0
      )
        return;
      this.shell = { ...shell, snapshot: this.cache.readShell(shell.snapshot) };
      this.cache.saveShell?.(connection.ready, this.shell);
    });
    this.directoryRequest = { connection, pending };
    try {
      await pending;
    } finally {
      if (this.directoryRequest?.pending === pending) this.directoryRequest = undefined;
    }
  }
  async activate(projectId) {
    const page = this.state.page;
    const connection = this.client.connection;
    const result = await this.client.request({
      method: "project.activate",
      context: { projectId },
      params: {},
    });
    if (!connection || this.client.connection !== connection || this.state.page !== page)
      throw Object.assign(new Error("LOCAL_NOT_SENT"), { code: "LOCAL_NOT_SENT" });
    if (result.projectId !== projectId || result.state !== "ready" || !result.serviceGeneration)
      throw Object.assign(new Error("ACTIVATION_PENDING"), {
        code: result.reason === "explicitlyStopped" ? "ACTIVATION_BLOCKED" : "ACTIVATION_PENDING",
      });
    return result.serviceGeneration;
  }
  cachedProject(projectId) {
    return this.shell?.snapshot.projects.find(
      (project) => project.projectId === projectId || project.alias?.projectId === projectId,
    );
  }
  projectOffline(projectId) {
    const cached = this.cachedProject(projectId);
    if (cached) return cached.state !== "ready";
    return (
      this.state.projects.find((project) => project.projectId === projectId)?.connectionState ===
      "offline"
    );
  }
  async work(projectId, mode, epoch = this.epoch) {
    const previous = this.state.groups[projectId];
    if (this.projectOffline(projectId) && !this.cachedProject(projectId))
      await this.readDirectory();
    if (epoch !== this.epoch) return;
    const offline = this.projectOffline(projectId);
    const append = mode === "append" && Boolean(previous?.saved) === offline;
    const expanded = mode === "refreshExpanded" && Boolean(previous?.saved) === offline;
    if (offline) {
      const summaries = this.cachedProject(projectId)?.summaries.items ?? [];
      const offset = append ? Number(previous?.nextCursor) || 0 : 0;
      const rows = summaries
        .filter((item) => !item.desktop?.archived)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const end = expanded
        ? Math.max(SESSION_PAGE_SIZE, previous.data.length)
        : offset + SESSION_PAGE_SIZE;
      const data = rows.slice(offset, end).map((item) => ({
        kind: "session",
        threadId: item.id,
        title: item.name,
        sourceUpdatedAt: item.updatedAt,
      }));
      this.publish({
        groups: {
          ...this.state.groups,
          [projectId]: {
            data: [...(append ? previous.data : []), ...data],
            nextCursor: end < rows.length ? String(end) : null,
            saved: true,
            expanded: append || expanded,
          },
        },
      });
      return;
    }
    const page = await this.client.request({
      method: "work.list",
      context: { projectId },
      params: {
        filter: "all",
        limit: SESSION_PAGE_SIZE,
        ...(append && previous?.nextCursor ? { cursor: previous.nextCursor } : {}),
      },
    });
    if (epoch !== this.epoch) return;
    if (append && previous.serviceGeneration !== page.serviceGeneration)
      return this.work(projectId, "replace", epoch);
    const keepExpanded = expanded && previous.serviceGeneration === page.serviceGeneration;
    const rows = keepExpanded
      ? [
          ...page.data,
          ...previous.data.filter(
            (row) =>
              !page.data.some((latest) =>
                row.kind === "taskRun"
                  ? latest.taskId === row.taskId && latest.runId === row.runId
                  : latest.threadId === row.threadId,
              ),
          ),
        ]
      : [
          ...new Map(
            [...(append ? previous.data : []), ...page.data].map((row) => [
              row.kind === "taskRun" ? `${row.taskId}/${row.runId}` : row.threadId,
              row,
            ]),
          ).values(),
        ];
    this.publish({
      groups: {
        ...this.state.groups,
        [projectId]: {
          ...page,
          data: rows.sort((a, b) => (b.sourceUpdatedAt ?? 0) - (a.sourceUpdatedAt ?? 0)),
          expanded: append || keepExpanded,
          ...(keepExpanded ? { nextCursor: previous.nextCursor } : {}),
        },
      },
    });
  }
  async more() {
    const page = this.state.page,
      epoch = this.epoch;
    if (
      page.kind !== "work" ||
      this.state.loading ||
      !this.state.groups[page.projectId]?.nextCursor
    )
      return;
    this.publish({ loading: true, error: false });
    try {
      await this.work(page.projectId, "append", epoch);
    } catch {
      if (epoch === this.epoch) this.publish({ error: true });
    } finally {
      if (epoch === this.epoch) this.publish({ loading: false });
    }
  }
  async open(page, epoch) {
    const connection = this.client.connection;
    if (this.projectOffline(page.projectId)) {
      const ready = this.client.snapshot().ready;
      if (ready.capabilities.includes("submit")) await this.activate(page.projectId);
      if (epoch !== this.epoch || connection !== this.client.connection) return;
    }
    this.release();
    this.history = [];
    this.visibleTurns = [];
    this.bodies.clear();
    this.publish({ detail: null, turns: [], loadingOlder: false });
    await this.client.request(
      {
        method: "session.open",
        context: { projectId: page.projectId },
        params: { threadId: page.threadId },
      },
      (detail) => {
        if (epoch !== this.epoch || connection !== this.client.connection) {
          this.release(detail, connection);
          return;
        }
        const ready = this.client.snapshot().ready;
        if (
          detail.connectionId !== ready.connectionId ||
          detail.gatewayGeneration !== ready.gatewayGeneration ||
          detail.projectId !== page.projectId ||
          detail.snapshot?.threadId !== page.threadId ||
          detail.sequence !== 0
        )
          throw new Error("STALE_SESSION");
        this.cursor = detail.snapshot.history.nextCursor;
        this.publish({ detail });
        this.cache.saveSession?.(ready, this.cachedProject(page.projectId)?.projectId, detail);
        this.renderTurns();
      },
    );
  }
  sessionEvent(message) {
    if (message.event?.startsWith("shell.")) {
      const shell = this.shell;
      if (
        !shell ||
        ["connectionId", "gatewayGeneration", "subscriptionId"].some(
          (key) => message[key] !== shell[key],
        )
      )
        return;
      if (message.sequence <= shell.sequence) return;
      try {
        if (message.event !== "shell.updated" || message.sequence !== shell.sequence + 1)
          throw new Error("STALE_SHELL");
        this.shell = {
          ...shell,
          sequence: message.sequence,
          snapshot: this.cache.applyShellDelta(shell.snapshot, message.delta),
        };
        this.cache.saveShell?.(this.client.snapshot().ready, this.shell);
      } catch {
        void this.readDirectory().catch(() => {});
      }
      return;
    }
    const result = acceptSessionMessage(this.state.detail, message);
    if (result.kind === "ignore") return;
    if (result.kind === "resync") {
      this.epoch++;
      this.publish({ loading: false });
      void this.refresh();
      return;
    }
    if (result.kind === "unavailable") {
      this.bodies.clear();
      this.publish({ detail: null, turns: [], error: true });
      return;
    }
    const previousSnapshot = this.state.detail.snapshot;
    const previous = previousSnapshot.turns;
    const next = result.value.snapshot;
    const currentItems = new Set(next.turns.flatMap((turn) => turn.items.map((item) => item.id)));
    const dropped = previous
      .map((turn) => ({ ...turn, items: turn.items.filter((item) => !currentItems.has(item.id)) }))
      .filter((turn) => turn.items.length);
    if (dropped.length) {
      const count = dropped.reduce((total, turn) => total + turn.items.length, 0);
      const last = this.history.at(-1);
      const retained = last?.rolling
        ? (last.turns?.reduce((total, turn) => total + turn.items.length, 0) ?? 0)
        : 0;
      if (last?.rolling && last.turns && retained + count <= 100) {
        last.turns.push(...dropped);
        last.cursor = next.history.nextCursor;
      } else
        this.history.push({
          id: crypto.randomUUID(),
          cursor: next.history.nextCursor,
          turns: dropped,
          rolling: true,
        });
      this.trimHistory(this.history.at(-1));
    }
    this.publish({ detail: result.value });
    if (previousSnapshot.activeTurnId && !next.activeTurnId) {
      this.cache.saveSession?.(
        this.client.snapshot().ready,
        this.cachedProject(result.value.projectId)?.projectId,
        result.value,
      );
    }
    this.renderTurns();
  }
  renderTurns() {
    const detail = this.state.detail;
    if (!detail) return;
    const merged = new Map();
    for (const turn of [
      ...this.history.flatMap((page) => page.turns ?? []),
      ...detail.snapshot.turns,
    ]) {
      const previous = merged.get(turn.id);
      merged.set(turn.id, {
        ...turn,
        items: [
          ...new Map(
            [...(previous?.items ?? []), ...turn.items].map((item) => [item.id, item]),
          ).values(),
        ],
      });
    }
    const turns = [...merged.values()];
    this.visibleTurns = turns;
    this.bodies.update(
      detail,
      turns,
      (request) => this.client.request(request),
      () =>
        this.publish({
          turns: this.bodies.decorate(this.visibleTurns),
          bodyError: !!this.bodies.error,
        }),
    );
    this.publish({ turns: this.bodies.decorate(turns), bodyError: !!this.bodies.error });
  }
  async older(pageId) {
    const detail = this.state.detail,
      epoch = this.epoch;
    const entry = pageId ? this.history.find((page) => page.id === pageId) : null;
    const cursor = entry?.cursor ?? this.cursor;
    if (!detail || !cursor || this.state.loadingOlder) return;
    this.publish({ loadingOlder: true });
    try {
      const page = await this.client.request({
        method: "session.history",
        context: { projectId: detail.projectId },
        params: { threadId: detail.snapshot.threadId, cursor },
      });
      if (
        epoch !== this.epoch ||
        !this.state.detail ||
        [
          "connectionId",
          "gatewayGeneration",
          "serviceGeneration",
          "subscriptionId",
          "projectId",
        ].some((key) => page[key] !== this.state.detail[key])
      )
        return;
      if (entry) entry.turns = page.turns;
      else {
        this.history.unshift({ id: crypto.randomUUID(), cursor, turns: page.turns });
        this.cursor = page.nextCursor;
      }
      this.trimHistory(entry);
      this.renderTurns();
    } finally {
      if (epoch === this.epoch) this.publish({ loadingOlder: false });
    }
  }
  trimHistory(keep) {
    const retained = this.history.filter((value) => value.turns && value !== keep);
    while (this.history.filter((value) => value.turns).length > 3) retained.pop().turns = null;
  }
  historyView() {
    return {
      supported: true,
      complete: !this.cursor,
      loadingOlder: this.state.loadingOlder,
      viewGeneration: this.epoch,
      gaps: this.history.flatMap((page, index) => {
        if (page.turns) return [];
        const next =
          this.history.slice(index + 1).find((value) => value.turns)?.turns ??
          this.state.detail?.snapshot.turns;
        return next?.[0]?.items?.[0] ? [{ id: page.id, beforeItemId: next[0].items[0].id }] : [];
      }),
    };
  }
  dispose() {
    clearInterval(this.poll);
    this.release();
    this.unsubscribe();
    this.bodies.clear();
  }
}
