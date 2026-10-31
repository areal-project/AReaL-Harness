// @ts-check
"use strict";
const { readFile, mkdir, realpath, stat } = require("node:fs/promises");
const { join, isAbsolute } = require("node:path");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const catalogContract = require("@areal/workbench/desktop-contract/catalog");
const { resolvedModelCapabilities } = require("@areal/provider-config");
const { homedir } = require("node:os");

// Desktop reserves workspace roots; Core remains the sole owner of threads and
// execution. Repeating a preparation ID never creates another root or a turn.
class ProjectlessWorkspaces {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend */
  constructor(backend) {
    this.backend = backend;
    /** @type {Record<string,{root:string,existing?:boolean}>} */
    this.records = {};
    /** @type {Promise<unknown>} */
    this.pending = Promise.resolve();
  }
  async init() {
    try {
      /** @type {unknown} */
      const value = JSON.parse(
        await readFile(join(this.backend.home, "projectless-drafts.json"), "utf8"),
      );
      if (!isAllocations(value)) throw new Error("项目外目录预约结构无效");
      this.records = value;
    } catch (error) {
      if (!modelRecord(error) || error.code !== "ENOENT") throw error;
    }
  }
  snapshot() {
    return {
      directory:
        this.backend.library.value.settings.projectlessDirectory ??
        join(this.backend.userHome ?? homedir(), "Documents", "AReaL"),
    };
  }
  /** @param {Record<string,unknown> & {operation:string}} request @returns {Promise<import("@areal/workbench/desktop-contract/catalog").ProjectlessCatalog|{directory:string}|{projectId:string,cwd:string}>} */
  async command(request) {
    if (!catalogContract.isRequest("projectless", request)) throw new Error("无效项目外请求");
    if (request.operation === "catalog") {
      const providers = this.backend.providers;
      const config = await providers.config.current();
      const selected = readEffectiveModel(config.effective);
      /** @type {Array<{providerId:string|null,providerName?:string,modelId:string,displayName:string,available:boolean,credentialState?:string,isDefault:boolean,parameters:import("./provider-contract.cjs").ModelParameters,capabilities?:import("./provider-contract.cjs").ModelCapabilities,reasoningEffortOptions:string[]}>} */
      const data = config.data
        .filter((provider) => provider.enabled)
        .flatMap((provider) => {
          const models = provider.models.filter((model) => model.enabled);
          if (
            provider.id === selected.provider &&
            selected.name &&
            !models.some((model) => model.id === selected.name)
          )
            models.push({ id: selected.name, parameters: {}, enabled: true });
          return models.map((model) => {
            const capabilities = resolvedModelCapabilities(provider, model);
            return {
              providerId: provider.id,
              providerName: provider.name,
              modelId: model.id,
              displayName: model.displayName ?? model.id,
              available: config.credentialStates[provider.id] !== "unavailable",
              credentialState: config.credentialStates[provider.id],
              isDefault: provider.id === selected.provider && model.id === selected.name,
              parameters: {
                ...provider.parameters,
                ...model.parameters,
                ...(provider.id === selected.provider &&
                model.id === selected.name &&
                selected.reasoning_effort
                  ? { reasoningEffort: selected.reasoning_effort }
                  : {}),
                ...(provider.id === selected.provider &&
                model.id === selected.name &&
                selected.service_tier
                  ? { serviceTier: selected.service_tier }
                  : {}),
              },
              capabilities,
              reasoningEffortOptions:
                capabilities?.reasoning === false
                  ? []
                  : (capabilities?.reasoningEffortOptions ?? []),
            };
          });
        });
      if (selected.name) {
        const configured = data.find(
          (model) => model.providerId === selected.provider && model.modelId === selected.name,
        );
        data.unshift({
          providerId: null,
          modelId: selected.name,
          displayName: configured?.displayName ?? selected.name,
          available:
            configured?.available ??
            (!!selected.endpoint &&
              (!selected.api_key_env ||
                !!providers.config.key({ apiKeyEnv: selected.api_key_env }))),
          isDefault: !data.some((model) => model.isDefault),
          parameters: {
            temperature: selected.temperature,
            maxOutputTokens: selected.max_output_tokens,
            contextWindowTokens: selected.context_window_tokens,
            reasoningEffort: selected.reasoning_effort,
            reasoningSummary: selected.reasoning_summary,
            serviceTier: selected.service_tier,
          },
          capabilities: configured?.capabilities,
          reasoningEffortOptions:
            configured?.reasoningEffortOptions ??
            resolvedModelCapabilities({ endpoint: selected.endpoint }, { id: selected.name })
              ?.reasoningEffortOptions ??
            [],
        });
      }
      const service = providers.openaiService;
      if (service?.catalog?.metadata()?.fresh)
        data.push(
          ...service.models.map((model) => ({
            providerId: "areal_openai",
            providerName: "ChatGPT",
            modelId: model.id,
            displayName: model.id,
            available: true,
            isDefault:
              config.defaultModel?.providerId === "areal_openai" &&
              config.defaultModel.modelId === model.id,
            parameters: model.parameters ?? {},
            capabilities:
              model.reasoningEffortOptions === undefined
                ? undefined
                : {
                    tools: true,
                    vision: true,
                    reasoning: true,
                    reasoningEffortOptions: model.reasoningEffortOptions,
                  },
            reasoningEffortOptions: model.reasoningEffortOptions ?? [],
          })),
        );
      return { models: data, lastAcceptedModel: providers.lastAcceptedModel ?? null };
    }
    if (request.operation === "directory") {
      if (typeof request.path !== "string" || !isAbsolute(request.path))
        throw new Error("请选择绝对目录路径");
      const directory = await realpath(request.path);
      if (!(await stat(directory)).isDirectory()) throw new Error("请选择文件夹");
      await this.backend.library.change((state) => {
        state.settings.projectlessDirectory = directory;
      });
      return this.snapshot();
    }
    if (
      request.operation !== "prepare" ||
      typeof request.requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.requestId)
    )
      throw new Error("无效项目外草稿标识");
    const id = request.requestId;
    const next = this.pending
      .catch(() => {})
      .then(async () => {
        let selected;
        if (request.directory !== undefined) {
          if (
            typeof request.directory !== "string" ||
            !isAbsolute(request.directory) ||
            request.directory.split(/[\\/]/).includes("..")
          )
            throw new Error("请选择现有文件夹的绝对路径");
          selected = await realpath(request.directory);
          if (!(await stat(selected)).isDirectory()) throw new Error("请选择现有文件夹");
        }
        let record = this.records[id];
        if (record && selected !== undefined && selected !== record.root)
          throw new Error("此草稿已绑定原工作目录，不能重新绑定；请创建新草稿");
        /** @param {string|undefined} root */
        const normalProject = (root) =>
          this.backend.saved.find((project) => project.root === root && !project.projectless);
        if (normalProject(record?.root ?? selected))
          throw new Error("此目录已属于已有项目，请选择该项目创建任务");
        if (!record) {
          if (selected === undefined) {
            const base = this.snapshot().directory;
            await mkdir(base, { recursive: true, mode: 0o700 });
            selected = join(await realpath(base), id);
          }
          record = {
            root: selected,
            ...(request.directory !== undefined ? { existing: true } : {}),
          };
          if (normalProject(record.root))
            throw new Error("此目录已属于已有项目，请选择该项目创建任务");
          const records = { ...this.records, [id]: record };
          await this.backend.save("projectless-drafts.json", records);
          this.records = records;
        }
        if (
          record.existing ||
          this.backend.saved.some((project) => project.projectlessRequestId === id)
        ) {
          if (!(await stat(record.root)).isDirectory()) throw new Error("原项目外目录不可用");
        } else await mkdir(record.root, { recursive: true, mode: 0o700 });
        if ((await realpath(record.root)) !== record.root)
          throw new Error("项目外目录已被替换，请检查原目录后重试");
        const projectId = await this.backend.addProjectPath(record.root, undefined, id);
        if (normalProject(record.root))
          throw new Error("此目录已属于已有项目，请选择该项目创建任务");
        return { projectId, cwd: record.root };
      });
    this.pending = next.catch(() => {});
    return next;
  }
}
/** @param {unknown} value @returns {value is Record<string,{root:string,existing?:boolean}>} */
function isAllocations(value) {
  return (
    modelRecord(value) &&
    Object.values(value).every(
      (record) =>
        modelRecord(record) &&
        typeof record.root === "string" &&
        isAbsolute(record.root) &&
        (record.existing === undefined || typeof record.existing === "boolean"),
    )
  );
}
/** @param {unknown} value */
function readEffectiveModel(value) {
  if (!modelRecord(value) || !effectiveModel(value.model)) throw new Error("有效模型配置结构无效");
  return value.model;
}
/** @param {unknown} value @returns {value is {provider?:string,name?:string,endpoint?:string,api_key_env?:string|null,temperature?:number|null,max_output_tokens?:number|null,context_window_tokens?:number|null,reasoning_effort?:string|null,reasoning_summary?:string|null,service_tier?:'fast'|'default'|null}} */
function effectiveModel(value) {
  return (
    modelRecord(value) &&
    ["provider", "name", "endpoint"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    ["api_key_env", "reasoning_effort", "reasoning_summary"].every(
      (key) => value[key] == null || typeof value[key] === "string",
    ) &&
    (value.service_tier == null ||
      value.service_tier === "fast" ||
      value.service_tier === "default") &&
    ["temperature", "max_output_tokens", "context_window_tokens"].every(
      (key) => value[key] == null || typeof value[key] === "number",
    )
  );
}
module.exports = { ProjectlessWorkspaces };
