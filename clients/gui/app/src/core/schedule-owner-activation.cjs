// @ts-check
"use strict";

// Startup activation has its own cause. Catalog consumers never call it.
class ScheduledOwnerActivation {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend */
  constructor(backend) {
    this.backend = backend;
    this.stopped = false;
    /** @type {Promise<void>|null} */
    this.pending = null;
    /** @type {Map<string,string>} */
    this.errors = new Map();
    this.attempt = 0;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    this.retryTimer = undefined;
  }
  /** @param {string} projectId */
  error(projectId) {
    return this.errors.get(projectId) ?? null;
  }
  /** @param {import('./project-index.cjs').SavedProject} owner */
  guard(owner) {
    if (this.stopped || this.backend.closing) throw new Error("应用正在退出");
    const saved = this.backend.saved.find(
      (saved) =>
        saved.id === owner.id &&
        saved.root === owner.root &&
        saved.logicalProjectId === owner.logicalProjectId,
    );
    if (!saved) throw new Error("安排执行工作区已移除");
    if (this.backend.lifecycleOperations.schedulingSuppressed(owner.id))
      throw new Error("安排执行工作区已由用户停止");
    this.backend.lifecycleOperations.assertProject(owner.id);
    this.backend.worktrees.assertAvailable(owner.id);
  }
  start() {
    if (this.pending) return this.pending;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const before = JSON.stringify([...this.errors]);
    const queue = [...this.backend.saved];
    this.pending = Promise.all(
      Array.from({ length: Math.min(2, queue.length) }, async () => {
        while (!this.stopped && !this.backend.closing && queue.length) {
          const owner = queue.shift();
          if (!owner) return;
          try {
            this.guard(owner);
            const catalog = await this.backend.ownerTasks.preview(owner, true);
            this.guard(owner);
            if (!catalog.data.some((task) => task.enabled)) continue;
            await this.backend.start(owner.id);
            this.guard(owner);
            this.errors.delete(owner.id);
          } catch (error) {
            if (!this.stopped && !this.backend.closing)
              this.errors.set(
                owner.id,
                this.backend.providers.redact(
                  error instanceof Error ? error.message : String(error),
                ),
              );
          }
        }
      }),
    )
      .then(() => {})
      .finally(() => {
        this.pending = null;
        if (JSON.stringify([...this.errors]) !== before) this.backend.onChange();
        this.retry();
      });
    return this.pending;
  }
  // 启动失败的安排执行工作区按退避重试，不能只在应用启动时尝试一次。
  retry() {
    if (this.stopped || this.backend.closing || !this.errors.size) {
      this.attempt = 0;
      return;
    }
    const delay = Math.min(5000 * 2 ** Math.min(this.attempt++, 6), 300000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.start();
    }, delay);
    this.retryTimer.unref?.();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
  }
}
module.exports = { ScheduledOwnerActivation };
