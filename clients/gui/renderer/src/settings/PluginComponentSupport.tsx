import { useI18n, type Translate } from "../i18n/IntlProvider.js";
export type ComponentSupport = {
  kind: string;
  sourceField: string;
  status: "supported" | "partial" | "unsupported";
  reasonCodes: string[];
  supportedSchema: string | null;
  required: boolean;
  activationRequirements: string[];
};
export type PackageComponentSupport = {
  digest: string;
  manifestFormat: string;
  components: ComponentSupport[];
  compatibility: { state: "allowed" | "blocked"; reasonCodes: string[] };
  validation: { scope: string; provider: string; platform: string; distribution: string };
};
const kinds = (t: Translate): Record<string, string> => ({
  skills: "Skills", mcp: "MCP", hooks: "Hooks", apps: "Connector", commands: "Commands", agents: "Agents", uiSurfaces: t("operations.uiPages"),
  outputStyles: t("operations.outputStyles"), themes: t("operations.themes"), lsp: t("operations.languageServers"),
});
const statuses = (t: Translate) => ({ supported: t("operations.supported"), partial: t("operations.partial"), unsupported: t("operations.unsupported") });
const reasons = (t: Translate): Record<string, string> => ({
  componentNotImplemented: t("operations.notImplemented"),
  hostRuntimeUnsupported: t("operations.hostRuntimeUnsupported"),
  packageDependenciesUnsupported: t("operations.packageDependenciesUnsupported"),
  userConfigUnsupported: t("operations.userConfigUnsupported"),
  invalidMcpEnvelope: t("operations.invalidMcp"),
  emptyMcpEnvelope: t("operations.emptyMcp"),
  invalidHookEnvelope: t("operations.invalidHook"),
  emptyHookEnvelope: t("operations.emptyHook"),
  unsupportedHookEnvelope: t("operations.unsupportedHook"),
  invalidConnectorEnvelope: t("operations.invalidConnector"),
  emptyConnectorEnvelope: t("operations.emptyConnector"),
  componentDocumentMissingOrInvalid: t("operations.invalidDocument"),
  emptyComponentDeclaration: t("operations.emptyDeclaration"),
});
const requirements = (t: Translate): Record<string, string> => ({
  declaredHostTools: t("operations.declaredHostTools"),
  installed: t("operations.installSnapshot"), enabled: t("operations.enableProject"), profileAllowsPluginSkills: t("operations.profileAllows"),
  explicitMcpTrust: t("operations.trustMcp"), mcpConnection: t("operations.connectMcp"), authentication: t("operations.authenticate"),
  authenticationWhenDeclared: t("operations.declaredAuth"), connectorMapping: t("operations.connectorMapping"),
  explicitHookDefinitionTrust: t("operations.trustHooks"), readOnlyHookConsentWhenApplicable: t("operations.readOnlyConsent"),
});
function reasonText(reason: string, t: Translate) {
  const [code, kind] = reason.split(":");
  if (code === "requiredKindMissing") return t("operations.missingKind", { kind: kinds(t)[kind] ?? kind });
  if (code === "requiredKindUnsupported") return t("operations.unsupportedKind", { kind: kinds(t)[kind] ?? kind });
  return reasons(t)[reason] ?? reason;
}
export function supportBlocked(report: PackageComponentSupport | null | undefined, digest: string | null) {
  return !!report && report.digest === digest && report.compatibility.state === "blocked";
}
export function PluginComponentSupport({ report, digest, installed }: {
  report?: PackageComponentSupport | null;
  digest: string | null;
  installed: boolean;
}) {
  const { t } = useI18n();
  const title = installed ? t("operations.installedSupport") : t("operations.catalogSupport");
  if (!report || report.digest !== digest) return <section className="plugin-detail-resources" aria-label={title}><h3>{title}</h3><p>{t("operations.unverifiedSupport")}</p></section>;
  const partial = report.components.some(row => row.status !== "supported");
  return <section className="plugin-detail-resources" aria-label={title}>
    <h3>{title}</h3>
    <p>{report.compatibility.state === "blocked" ? t("operations.blockedSnapshot") : partial ? t("operations.partialComponents") : t("operations.declaredSupport")}</p>
    {report.compatibility.reasonCodes.length > 0 && <ul>{report.compatibility.reasonCodes.map(reason => <li key={reason}>{reasonText(reason, t)}</li>)}</ul>}
    <p>{t("operations.profileAdmission")}</p>
    <p>{t("operations.separateTrust")}</p>
    <details><summary>{t("operations.viewRequirements")}</summary>
      <p>{t("operations.snapshot")} <code>{report.digest}</code></p>
      {!report.components.length && <p>{t("operations.noComponents")}</p>}
      <ul>{report.components.map((row, index) => <li key={`${row.sourceField}:${index}`}>
        <strong>{kinds(t)[row.kind] ?? row.kind} · {statuses(t)[row.status]}{row.required ? t("operations.required") : ""}</strong>
        <p><code>{row.sourceField}</code></p>
        {row.reasonCodes.map(reason => <p key={reason}>{reasonText(reason, t)}</p>)}
        {row.supportedSchema && <p>{t("operations.parsingContract")} <code>{row.supportedSchema}</code></p>}
        {!!row.activationRequirements.length && <p>{t("operations.requirements")}{row.activationRequirements.map(value => requirements(t)[value] ?? value).join("、")}。</p>}
      </li>)}</ul>
    </details>
  </section>;
}
