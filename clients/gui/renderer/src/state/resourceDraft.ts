import { UiMessageError } from "../i18n/IntlProvider.js";
import { composerDraftStorage } from "../composerDraftStorage.js";
import { readComposerSkills, type ComposerSkill } from "../ComposerSkills.js";
import { profileKey, resolveDraftProfile } from "../ProfileDetails.js";
import {
  type Data,
  type PlatformServices,
  type PreparedCreator,
  type Snapshot,
} from "../services.js";
import type { ResourceDraftSeed } from "../settings/PluginSkillsPage.js";
import { useSessionNavigation } from "../state/useSessionNavigation.js";

// 刷新 Skill 可能重启 Core；订阅后再读快照，等同一项目的新配置可见后才修改草稿。
async function preparedSnapshot(
  services: PlatformServices,
  projectId: string,
  profile: PreparedCreator["profile"],
): Promise<Snapshot> {
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Snapshot>((resolve, reject) => {
      const observe = (snapshot: Snapshot) => {
        const project = snapshot.projects.find(
          (item) => item.id === projectId && !item.projectless,
        );
        if (
          project?.state?.connected &&
          project.profiles.some((item: Data) => profileKey(item) === profileKey(profile))
        )
          resolve(snapshot);
      };
      timer = setTimeout(
        () => reject(new UiMessageError({ id: "settings.pluginSkillsPage.profileNotReady" })),
        15_000,
      );
      unsubscribe = services.onState(observe);
      void services.snapshot().then(observe, reject);
    });
  } finally {
    clearTimeout(timer);
    unsubscribe?.();
  }
}

export async function prepareResourceDraft(
  seed: ResourceDraftSeed,
  project: Data | undefined,
  snapshot: ReturnType<typeof useSessionNavigation>["snapshot"],
  services: PlatformServices,
  resourceAction: ReturnType<typeof useSessionNavigation>["resourceAction"],
  setSnapshot: ReturnType<typeof useSessionNavigation>["setSnapshot"],
) {
  const sourceProject = seed.kind === "creator" ? seed.projectId : seed.standalone?.projectId;
  const owner = sourceProject
    ? snapshot.projects.find((item) => item.id === sourceProject && !item.projectless)
    : project?.projectless
      ? undefined
      : project;
  if (sourceProject && !owner)
    throw new UiMessageError({ id: "settings.pluginSkillsPage.connectProjectForDraft" });
  const key = owner ? `areal-gui:draft:${owner.id}:new` : "areal-gui:draft:projectless:new";
  let text: string;
  let skill: ComposerSkill | undefined;
  let resourceProfile: PreparedCreator["profile"] | undefined;
  if (seed.kind === "creator") {
    if (!owner) throw new Error("请先选择要创建 Skill 的项目。");
    const selection = localStorage.getItem(`${key}:profile`);
    let requestedProfile: PreparedCreator["profile"] | undefined;
    if (selection !== null) {
      try {
        requestedProfile = JSON.parse(selection);
      } catch {
        throw new Error("保存的任务配置无效，现有草稿已保留。");
      }
    }
    const prepared = await resourceAction("prepareCreator", {
      projectId: owner.id,
      ...(selection !== null ? { profile: requestedProfile } : {}),
    });
    const refreshed = await preparedSnapshot(services, owner.id, prepared.profile);
    setSnapshot(refreshed);
    resourceProfile = prepared.profile;
    skill = { ...prepared.skill, source: "官方 · OpenAI" };
    const destination = `${owner.root.replace(/[\\/]+$/, "")}/.agents/skills/<name>`;
    text = `请使用 Skill Creator 帮我在当前所选项目中创建一个可复用的 Skill。安装位置已固定为 ${destination}；请直接使用此目录，不要询问、确认路径或改用个人/全局 Skill 目录。请按 Skill Creator 的指导初始化并验证 Skill，先了解我希望复用的工作和具体需求。`;
  } else {
    ({ text, skill } = seed);
    const importedProfile = seed.profile;
    if (importedProfile) {
      if (
        !owner?.state?.connected ||
        !owner.profiles.some(
          (profile: Data) =>
            profile.id === importedProfile.id && profile.revision === importedProfile.revision,
        )
      )
        throw new UiMessageError({ id: "settings.pluginCenter.agentProfileUnavailable" });
      resourceProfile = importedProfile;
    }
  }
  if (owner && seed.kind !== "creator") {
    if (!owner.state?.connected) throw new Error("连接当前项目后再使用 Skill，现有输入已保留。");
    const selection = localStorage.getItem(`${key}:profile`);
    const profile = resolveDraftProfile(owner, selection);
    if (!profile && (selection || !seed.standalone))
      throw new Error("当前任务配置不可用，无法附加 Skill。");
    const available =
      skill && profile
        ? await resourceAction("manage", {
            projectId: owner.id,
            operation: "skills",
            agentProfile: { id: profile.id, revision: profile.revision },
          })
        : null;
    if (
      skill &&
      !(available?.data ?? []).some(
        (item: Data) => item.available && item.id === skill.id && item.revision === skill.revision,
      )
    ) {
      if (!seed.standalone)
        throw new Error("当前任务配置未提供此 Skill 的确切版本，现有草稿已保留。");
      const prepared = await resourceAction("resources", {
        operation: "skillPrepare",
        projectId: owner.id,
        skill: { id: skill.id, revision: skill.revision },
        ...(selection && profile
          ? { profile: { id: profile.id, revision: profile.revision } }
          : {}),
      });
      setSnapshot(await preparedSnapshot(services, owner.id, prepared.profile));
      resourceProfile = prepared.profile;
    }
  }
  const existingSkills = readComposerSkills(key);
  const existingText = composerDraftStorage.getItem(key) || "";
  composerDraftStorage.setItem(key, existingText.trim() ? `${existingText}\n\n${text}` : text);
  if (
    skill &&
    !existingSkills.some((item) => item.id === skill.id && item.revision === skill.revision)
  )
    localStorage.setItem(`${key}:skills`, JSON.stringify([...existingSkills, skill]));
  if (resourceProfile) localStorage.setItem(`${key}:profile`, profileKey(resourceProfile));

  return { owner, key };
}
