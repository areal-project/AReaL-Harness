import { SettingsGroupCard, SettingsRow, SettingsSection } from "./SettingsPageParts.js";
import type { Data } from "../services.js";

/** Read-only deployment projection; viewing it never connects or starts Core. */
export function CoreCapabilitiesSettings({ projects, connected }: { projects: Data[]; connected: boolean }) {
  return <section aria-label="Core 连接与能力" className="settings-sections">
    <SettingsSection title="Core 连接与能力" description="当前运行环境声明的功能。实际操作仍受权限、部署配置和任务状态限制。">
      {!projects.length && <p role="status">尚未连接工作区，能力信息尚未读取。</p>}
      {projects.map(project => {
        const core = project.core, available = connected && !!project.state?.connected;
        const error = project.error || project.state?.error;
        return <SettingsGroupCard key={project.id}>
          <SettingsRow label={project.root.split(/[\\/]/).filter(Boolean).at(-1) || "工作区"} description={project.root}
            control={<span>{available ? "Core 已连接" : "Core 未连接，上次能力信息可能已过期。"}</span>} />
          {error && <p role="alert" className="px-4 text-destructive">{error}</p>}
          {core?.binary && <SettingsRow control={null} label="Core 程序" description={<span className="break-all">{core.binary}</span>} />}
          {core?.apiVersion && <SettingsRow label="Core 接口版本" control={<span>{core.apiVersion}</span>} />}
          {core?.runtimeEpoch && <SettingsRow control={null} label="Runtime 实例" description={<span className="break-all">{core.runtimeEpoch}</span>} />}
          {!core?.features ? <p role="status" className="px-4">尚未取得 Core 能力；连接成功后可核对。</p> : <>
            <SettingsRow control={null} label="会话与对话" description={core.features.conversation ? "对话执行可用" : "当前 Core 未提供对话执行能力。"} />
            <SettingsRow control={null} label="持续目标" description={core.features.goals ? "持续目标可用" : "当前 Core 未提供持续目标能力。"} />
            <SettingsRow control={null} label="任务与收件箱" description={core.features.tasks ? "任务与收件箱可用" : "当前 Core 未提供任务与收件箱能力。"} />
            <SettingsRow control={null} label="受管进程与终端" description={core.features.processes ? "受管进程与终端可用" : core.runtimeAvailable === false ? "当前 Core 未连接 Runtime，受管进程与终端不可用。" : "当前 Core 未提供完整的受管进程能力，请使用支持此功能的 Core。"} />
            <SettingsRow control={null} label="子任务执行" description={core.features.executions ? "Core 自动安排子任务，统一返回进度与交付结果。" : "当前 Core 未提供统一子任务接口，可读取兼容任务历史。"} />
          </>}
        </SettingsGroupCard>;
      })}
    </SettingsSection>
  </section>;
}
