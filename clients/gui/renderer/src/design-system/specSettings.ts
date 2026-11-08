import fixture from "../../../../../design/spec/fixtures/send-run-stop.json";
import type { Data } from "../services.js";

// 设置各页的示例后台：只答读取，日期以示例数据里的“今天”为准。
const sample = fixture.settingsBackend;
const day = (offset: number) => {
  const date = new Date(`${sample.today}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};
const at = (offset: number) => new Date(`${day(offset)}T10:00:00`).getTime();

function usage(): Data {
  const days: Data = {};
  sample.usage.days.forEach((tokens, index) => {
    days[day(index - sample.usage.days.length + 1)] = {
      activeMs: tokens * 60,
      tokens,
      skillCalls: Math.round(tokens / 20_000),
    };
  });
  const values = Object.values(days) as Data[];
  return {
    since: at(-sample.usage.days.length),
    today: day(0),
    yesterday: day(-1),
    days,
    activeMs: values.reduce((sum, item) => sum + item.activeMs, 0),
    activeDays: values.length,
    streak: values.length,
    longestStreak: values.length,
    tokens: values.reduce((sum, item) => sum + item.tokens, 0),
    undatedTokens: 0,
    reportedTurns: values.length * 6,
    skillCalls: sample.usage.skills.reduce((sum, item) => sum + item.calls, 0),
    undatedSkills: 0,
    skills: sample.usage.skills,
    syncing: false,
    error: null,
  };
}

function trajectory(): Data {
  const records = sample.trajectory.map((record, index) => ({
    id: `record-${index}`,
    status: record.status,
    created_at: at(-index),
    uploaded_at: record.status === "uploaded" ? at(-index) : null,
    attempts: record.status === "failed" ? 3 : 1,
    next_attempt_at: null,
    bytes: record.bytes,
    error: record.error ?? null,
    model_name: "示例模型",
    model_call_duration_ms: record.ms,
  }));
  const count = (status: string) => records.filter((item) => item.status === status).length;
  return {
    enabled: true,
    state: "ready",
    endpoint: "https://flywheel.example.com",
    configPath: null,
    spool_dir: "~/.areal/trajectories",
    worker_running: true,
    queue: {
      pending: count("pending"),
      uploading: count("uploading"),
      failed: count("failed"),
      uploaded: count("uploaded"),
      evicted: 0,
      bytes: records.reduce((sum, item) => sum + item.bytes, 0),
      max_bytes: 512 * 1024 ** 2,
      dropped_memory: 0,
      dropped_oversize: 0,
    },
    last_error: null,
    last_success_at: at(0),
    records,
    limits: { max_retries: 5, upload_interval_ms: 30_000, max_memory_bytes: 64 * 1024 ** 2 },
    config_revision: "c".repeat(64),
    capture_apply_pending: false,
    capture_apply_error: null,
  };
}

function providers(): Data {
  const capabilityDefaults = { stream: true, tools: true, usage: true };
  const discovery = { strategy: "none", path: "", shape: "" };
  const data = sample.providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    endpoint: provider.baseUrl,
    protocol: "openai-chat",
    baseUrl: provider.baseUrl,
    enabled: true,
    models: provider.models.map((id) => ({ id, enabled: true, parameters: {} })),
    parameters: {},
    connection: {
      definitionId: provider.id,
      connectionId: provider.id,
      billing: "apiKey",
      authentication: "apiKey",
      credentialSource: "stored",
      region: null,
      discovery,
      capabilityDefaults,
    },
  }));
  const application = { kind: "applied", revision: "1" };
  return {
    path: "~/.areal/providers.json",
    revision: "1",
    defaultModel: { providerId: data[0].id, modelId: data[0].models[0].id },
    credentialStates: Object.fromEntries(data.map((item) => [item.id, "stored"])),
    credentialSources: Object.fromEntries(data.map((item) => [item.id, "stored"])),
    effective: {},
    data,
    projects: [],
    pendingApply: false,
    application,
    definitions: [],
  };
}

export function settingsAction(name: string, request: Data): Data | undefined {
  const operation = request?.operation;
  if (name === "analytics" && operation === "read") return usage();
  if (name === "trajectory" && operation === "status") return trajectory();
  if (name === "feedback" && operation === "status")
    return {
      enabled: true,
      connected: true,
      installation: null,
      account: null,
      destination: null,
      opted_in: true,
    };
  if (name === "cloud" && operation === "status")
    return { baseURL: sample.cloud.baseURL, tokenConfigured: true };
  if (name === "computerControl" && operation === "status")
    return { supported: true, platform: "darwin", ready: true, ...sample.computer };
  if (name === "remoteControl" && operation === "status")
    return {
      enabled: true,
      connected: true,
      relay: sample.mobile.relay,
      relayUrl: sample.mobile.relay,
      directEnabled: false,
      pending: [],
      deviceGrants: sample.mobile.devices.map((device, index) => ({
        devicePeerId: `device-${index}`,
        name: device.name,
        displayName: device.name,
        clientKind: "ios",
        status: "active",
        online: device.online,
        pairedAt: at(-30),
        lastSeenAt: at(-index),
        projectIds: [],
        capabilities: [],
        revision: 1,
      })),
    };
  if (name === "resources" && operation === "hooks")
    return {
      path: "~/.areal/hooks.json",
      external: false,
      revision: "1",
      hooks: sample.hooks,
      projects: [],
    };
  if (name === "workspace" && operation === "worktreeList")
    return {
      settings: sample.worktrees.settings,
      defaultRoot: sample.worktrees.settings.worktreeRoot,
      revision: 1,
      projects: [
        {
          id: "spec-project",
          root: `/${fixture.project.name}`,
          name: fixture.project.name,
          environments: [],
          environmentRevision: 1,
        },
      ],
      worktrees: sample.worktrees.list,
    };
  if (name === "providers" && operation === "list") return providers();
  if (name === "chatgpt" && operation === "status") return { accounts: [], models: [] };
  return undefined;
}
