import { ProviderError, responseError, safeRefresh } from "./errors.js";

// 只投影当前账号的上游能力；不根据模型名称猜测或扩充档位。
export function modelCatalog(models) {
  if (!Array.isArray(models)) throw new Error("Invalid OpenAI model catalog");
  return models
    .filter(
      (m) =>
        m.visibility === "list" && typeof m.slug === "string" && m.slug && m.slug.length <= 256,
    )
    .slice(0, 64)
    .map((m) => {
      const efforts = m.supported_reasoning_levels;
      if (
        efforts !== undefined &&
        (!Array.isArray(efforts) ||
          efforts.length > 16 ||
          efforts.some(
            (level) =>
              typeof level?.effort !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(level.effort),
          ))
      )
        throw new Error("Invalid OpenAI reasoning capabilities");
      const options = [...new Set((efforts ?? []).map((level) => level.effort))];
      const defaultEffort = options.length ? m.default_reasoning_level : undefined;
      if (defaultEffort != null && !options.includes(defaultEffort))
        throw new Error("Invalid OpenAI default reasoning effort");
      return {
        id: m.slug,
        name: typeof m.display_name === "string" ? m.display_name.slice(0, 256) : m.slug,
        reasoningEffortOptions: options,
        ...(defaultEffort != null ? { defaultReasoningEffort: defaultEffort } : {}),
      };
    });
}

export class ModelCatalog {
  constructor(session, fetch, { now = Date.now, ttlMs = 30_000 } = {}) {
    Object.assign(this, { session, fetch, now, ttlMs });
    this.clear();
    session.on("changed", () => this.clear());
  }
  clear() {
    this.models = [];
    this.revision = null;
    this.fetchedAt = null;
    this.expiresAt = 0;
  }
  metadata() {
    return {
      source: "account",
      fetchedAt: this.fetchedAt,
      fresh: this.expiresAt > this.now(),
      sessionRevision: this.revision,
      overrides: false,
    };
  }
  async discover({ force = false } = {}) {
    if (
      !force &&
      !this.session.failure &&
      this.revision === this.session.revision &&
      this.expiresAt > this.now()
    )
      return this.models;
    if (this.loading && this.loadingRevision === this.session.revision) return this.loading;
    const revision = this.session.revision;
    this.loadingRevision = revision;
    const work = this.load(revision)
      .catch((error) => {
        // 旧账户请求的迟到错误不能覆盖当前账户的目录或恢复状态。
        if (revision === this.session.revision) {
          this.clear();
          throw this.session.fail(error, error?.phase ?? "catalog");
        }
        throw new ProviderError("account_changed", { phase: "catalog" });
      })
      .finally(() => {
        if (this.loading === work) this.loading = null;
      });
    this.loading = work;
    return work;
  }
  async load(revision) {
    let access = await this.session.accessToken();
    const send = (token) =>
      this.fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.any([this.session.lifetime.signal, AbortSignal.timeout(30_000)]),
      });
    let response = await send(access);
    if (response.status === 401) {
      const failure = await responseError(response, "catalog", [access]);
      if (!safeRefresh(failure)) throw failure;
      access = await this.session.accessToken(undefined, { force: true, rejectedToken: access });
      response = await send(access);
    }
    if (!response.ok) throw await responseError(response, "catalog", [access]);
    let bytes = 0,
      chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new ProviderError("invalid_response", { phase: "catalog" });
      chunks.push(chunk);
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ProviderError("invalid_response", { phase: "catalog" });
    }
    if (!Array.isArray(data.models))
      throw new ProviderError("invalid_response", { phase: "catalog" });
    if (revision !== this.session.revision || this.session.busy)
      throw new ProviderError("account_changed", { phase: "catalog" });
    const seen = new Set();
    const visible = data.models.filter((m) => {
      if (m.visibility !== "list" || typeof m.slug !== "string" || !m.slug ||
          m.slug.length > 256 || seen.has(m.slug) || m.slug.includes(access)) return false;
      seen.add(m.slug);
      return true;
    }).map((m) => ({ ...m, display_name: typeof m.display_name === "string" &&
      m.display_name.length <= 256 && !m.display_name.includes(access) ? m.display_name : m.slug }));
    this.models = modelCatalog(visible).map((m) => ({ ...m, source: "account" }));
    this.revision = revision;
    this.fetchedAt = this.now();
    this.expiresAt = this.fetchedAt + this.ttlMs;
    // 目录恢复只清目录错误；403/额度等推理失败不能被目录成功伪装成 ready。
    if (this.session.failure?.phase === "catalog") this.session.failure = null;
    return this.models;
  }
}
