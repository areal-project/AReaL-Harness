import type { PluginDetail, PluginOperation } from "./pluginTypes.js";

export type PluginConnectionFacts = {
  pluginId: string;
  installedDigest: string;
  authRequired: boolean;
  authPending: boolean;
  authUnknown: boolean;
  connected: boolean;
  partial: boolean;
  cleanupUnknown: boolean;
  uncertain: boolean;
  configurationBlocked: boolean;
  mappingRequired: boolean;
};
export type PluginPresentation = {
  state:
    | "unknown"
    | "working"
    | "notInstalled"
    | "disabled"
    | "blocked"
    | "notObserved"
    | "configure"
    | "partial"
    | "authenticate"
    | "authenticationPending"
    | "reviewMcp"
    | "available";
  nextAction:
    | "queryOriginal"
    | "wait"
    | "install"
    | "enable"
    | "components"
    | "connectProject"
    | "chooseProject"
    | "refresh"
    | "configure"
    | "connections"
    | "none";
  skillsAvailable: boolean;
  hookReviewRequired: boolean;
};

export function presentPlugin({
  detail,
  runtimeObserved,
  projectSelected = false,
  connection,
  submission,
  working = false,
  hostAvailable,
  runtimeDiagnostics,
}: {
  detail: PluginDetail;
  runtimeObserved: boolean;
  projectSelected?: boolean;
  connection?: PluginConnectionFacts | null;
  submission?: PluginOperation | null;
  working?: boolean;
  hostAvailable?: boolean;
  runtimeDiagnostics?: string[];
}): PluginPresentation {
  const report =
    detail.installedComponentSupport?.digest === detail.installedDigest
      ? detail.installedComponentSupport
      : null;
  const facts =
    connection?.pluginId === detail.id && connection.installedDigest === detail.installedDigest
      ? connection
      : null;
  const skillsAvailable =
    detail.installed &&
    detail.enabled &&
    report?.compatibility.state !== "blocked" &&
    !!detail.installedSkills?.some(
      (skill) => !detail.componentChoices?.disabledSkills?.includes(skill.id),
    );
  const hookReviewRequired = !!report?.components.some((component) => component.kind === "hooks");
  const result = (
    state: PluginPresentation["state"],
    nextAction: PluginPresentation["nextAction"],
  ): PluginPresentation => ({ state, nextAction, skillsAvailable, hookReviewRequired });
  if (submission?.pluginId === detail.id) return result("unknown", "queryOriginal");
  if (working) return result("working", "wait");
  if (!detail.installed)
    return result(
      "notInstalled",
      runtimeObserved ? "install" : projectSelected ? "connectProject" : "chooseProject",
    );
  if (!runtimeObserved)
    return result("notObserved", projectSelected ? "connectProject" : "chooseProject");
  if (!detail.enabled) return result("disabled", "enable");
  if (report?.compatibility.state === "blocked") return result("blocked", "components");
  if (detail.userConfiguration?.missingRequired.length)
    return result(skillsAvailable ? "partial" : "configure", "configure");
  if (!report) return result("notObserved", "refresh");
  if (runtimeDiagnostics?.length) return result("partial", "components");
  if (hostAvailable === false) return result("blocked", "components");
  if (facts?.configurationBlocked || facts?.mappingRequired)
    return result("configure", "configure");
  if (facts?.cleanupUnknown || facts?.uncertain || facts?.authUnknown)
    return result("partial", "connections");
  if (facts?.authPending) return result("authenticationPending", "connections");
  if (facts?.authRequired)
    return result(skillsAvailable ? "partial" : "authenticate", "connections");
  if (facts?.partial) return result("partial", "connections");
  if (report?.components.some((component) => component.kind === "mcp") && !facts?.connected)
    return result(skillsAvailable ? "partial" : "reviewMcp", "connections");
  if (report?.components.some((component) => component.status !== "supported"))
    return result("partial", "components");
  return result("available", "none");
}
