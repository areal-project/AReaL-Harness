import { acceptSessionMessage, SessionBodyReader } from "@areal/remote-client";

/** @typedef {import('../services.js').Data} Data */
/** @typedef {{kind:'projects'}|{kind:'new',projectId:string}|{kind:'work',projectId:string}|{kind:'session',projectId:string,threadId:string}|{kind:'task',projectId:string,taskId:string,runId:string}} MobilePage */
/** @typedef {{page:MobilePage, projects:Data[], groups:Record<string,Data>, detail:Data|null, turns:Data[], task:Data|null, catalog:Data|null, loading:boolean, error:boolean, loadingOlder:boolean, bodyError:boolean}} WorkspaceView */
export class MobileWorkspace {
  constructor(client) {
    this.client = client;
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
      this.epoch++;
      this.bodies.clear();
      this.history = [];
      this.visibleTurns = [];
      this.publish({
        ...(this.client.snapshot().kind === "unpaired" ? { page: { kind: "projects" } } : {}),
        projects: [],
        groups: {},
        detail: null,
        turns: [],
        task: null,
        catalog: null,
        loading: false,
        loadingOlder: false,
      });
      return;
    }
    this.observedConnection = this.client.connection;
    void this.refresh();
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
        await this.client.request({ method: "host.describe", params: {} });
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
        for (const project of projects) {
          if (project.connectionState !== "online") continue;
          await this.work(project.projectId, "replace", epoch);
          if (epoch !== this.epoch) return;
        }
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
  async work(projectId, mode, epoch = this.epoch) {
    const append = mode === "append";
    const expanded = mode === "refreshExpanded";
    const previous = this.state.groups[projectId];
    const page = await this.client.request({
      method: "work.list",
      context: { projectId },
      params: {
        filter: "all",
        limit: 30,
        ...(append && previous?.nextCursor ? { cursor: previous.nextCursor } : {}),
      },
    });
    if (epoch !== this.epoch) return;
    if ((append || expanded) && previous.serviceGeneration !== page.serviceGeneration)
      throw new Error("STALE_PROJECT");
    const rows = expanded
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
          data: rows,
          expanded: append || expanded,
          ...(expanded ? { nextCursor: previous.nextCursor } : {}),
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
        this.renderTurns();
      },
    );
  }
  sessionEvent(message) {
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
    const previous = this.state.detail.snapshot.turns;
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
