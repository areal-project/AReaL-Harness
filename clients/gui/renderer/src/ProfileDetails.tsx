import type { Data } from "./services.js";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";

export const profileKey = (profile: Data) =>
  JSON.stringify({ id: profile.id, revision: profile.revision });

export function resolveDraftProfile(project: Data, selection?: string | null): Data | undefined {
  if (selection) return project.profiles.find((profile: Data) => profileKey(profile) === selection);
  const reference = project.defaultProfile;
  return reference
    ? project.profiles.find(
        (profile: Data) => profile.id === reference.id && profile.revision === reference.revision,
      )
    : undefined;
}

/** Deployed restrictions are read from Core; this surface never edits deployment. */
export function ProfileDetails({ profile }: { profile: Data }) {
  return (
    <SettingsDisclosure className="text-ui-sm text-foreground-subtle" open title="预设能力与限制">
      <p>{profile.readOnly ? "只读预设" : "可写预设（仍受部署权限限制）"}</p>
      <p>
        允许工具：
        {profile.toolAllowlist == null ? "按部署权限" : profile.toolAllowlist.join("、") || "无"}
      </p>
      <p>
        预设模型：
        {profile.model ? `${profile.model.providerId}/${profile.model.modelId}` : "部署默认模型"}
      </p>
      <p>
        Skills：
        {profile.skills?.map((skill: Data) => `${skill.id} · ${skill.revision}`).join("、") || "无"}
      </p>
      <p>
        关联 Workflow：
        {profile.workflow ? `${profile.workflow.id} · ${profile.workflow.revision}` : "无"}
      </p>
      <p>
        需审批工具：{profile.approvalTools?.join("、") || "无额外要求"} · 会话进程：
        {profile.allowThreadProcesses ? "允许" : "不允许"}
      </p>
      {!!profile.requiredModalities?.length && (
        <p>所需模态：{profile.requiredModalities.join("、")}</p>
      )}
      <SettingsDisclosure title="预设指令">
        <p className="whitespace-pre-wrap break-words">{profile.instructions || "无额外指令"}</p>
      </SettingsDisclosure>
    </SettingsDisclosure>
  );
}
