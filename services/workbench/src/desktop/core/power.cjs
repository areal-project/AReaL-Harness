// @ts-check
"use strict";
const { modelRecord } = require("@areal/workbench/core-model-contract");

class SharedPowerMonitor {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend */
  constructor(backend) {
    this.backend = backend;
    /** @type {Promise<void>|null} */ this.pending = null;
    /** @type {boolean|undefined} */ this.expected = undefined;
    /** @type {NodeJS.Timeout|undefined} */ this.timer = undefined;
    this.stopped = false;
  }
  start() {
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {});
    }, 2000);
    void this.refresh().catch(() => {});
  }
  /** @returns {Promise<void>} */
  refresh() {
    if (this.stopped) return Promise.resolve();
    const enabled = this.backend.library.value.settings.preventSleep !== false;
    if (this.pending) {
      if (this.expected === enabled) return this.pending;
      return this.pending.catch(() => {}).then(() => this.refresh());
    }
    this.expected = enabled;
    this.pending = this.read().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async read() {
    try {
      this.backend.host.client.requireCapability("powerV1");
      const state = await this.backend.host.client.request("host.power", {
        sourceId: this.backend.host.sourceId,
      });
      if (
        !modelRecord(state) ||
        typeof state.enabled !== "boolean" ||
        typeof state.active !== "boolean" ||
        !(state.error === null || typeof state.error === "string")
      )
        throw new Error("Host 休眠保护状态无效");
      if (state.enabled !== (this.backend.library.value.settings.preventSleep !== false))
        throw new Error("已保存的休眠设置尚未由 Host 确认，请刷新状态");
      if (!this.stopped)
        this.apply({ enabled: state.enabled, active: state.active, error: state.error });
    } catch (error) {
      if (!this.stopped)
        this.apply({
          enabled: this.backend.library.value.settings.preventSleep !== false,
          active: this.backend.power?.active === true,
          error: error instanceof Error ? error.message : "Host 休眠保护状态暂不可用",
        });
      throw error;
    }
  }
  /** @param {{enabled:boolean,active:boolean,error:string|null}} state */
  apply(state) {
    if (JSON.stringify(state) === JSON.stringify(this.backend.power)) return;
    this.backend.power = state;
    queueMicrotask(() => {
      if (!this.stopped) this.backend.onChange();
    });
  }
  close() {
    this.stopped = true;
    clearInterval(this.timer);
  }
}
module.exports = { SharedPowerMonitor };
