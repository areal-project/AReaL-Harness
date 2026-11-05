import { useState } from "react";
import { Input, Button } from "@areal/ui";
import { useI18n } from "../i18n/IntlProvider.js";
import type { CommandParams, Data } from "../services.js";

/** 指纹按 4 个字符分组，方便和手机上显示的逐组对照。 */
export function fingerprintGroups(id: string) {
    return id.match(/.{1,4}/g) ?? [];
}

/** 新设备确认与已授权设备修改共用的项目与权限表单。 */
export function GrantReview({
    device,
    projects,
    pending,
    busy,
    run,
    onCancel,
}: {
    device: Data;
    projects: Data[];
    pending?: boolean;
    busy: boolean;
    run: (request: CommandParams<"remoteControl">) => Promise<Data | undefined>;
    onCancel?: () => void;
}) {
    const { t } = useI18n();
    const id = device.devicePeerId ?? device.id;
    // 只有一个项目时默认勾选它；多个项目时由用户明确选择，不默认放开全部。
    const [selected, setSelected] = useState<string[]>(
        device.projectIds ?? (projects.length === 1 ? [projects[0].id] : []),
    );
    // 新配对默认可查看、提交、审批；已配对设备保持原授权。管理单独勾选，默认不开。
    const [preset, setPreset] = useState<"Observer" | "Operator">(
        pending || device.capabilities?.includes("submit") ? "Operator" : "Observer",
    );
    const [manage, setManage] = useState(device.capabilities?.includes("manage") === true);
    return (
        <fieldset
            aria-label={t(
                pending
                    ? "settings.mobileSettings.confirmDeviceLabel"
                    : "settings.mobileSettings.authorizeDeviceLabel",
                { device: id },
            )}
            className="remote-grant"
        >
            {pending && (
                <div className="remote-fingerprint">
                    <p className="remote-field-label">
                        {t("settings.mobileConnect.fingerprintHint")}
                    </p>
                    <code aria-label={id}>
                        {fingerprintGroups(id).map((group, index) => (
                            <span key={index}>{group}</span>
                        ))}
                    </code>
                </div>
            )}
            {!pending && device.status === "reviewRequired" && (
                <p className="remote-muted">
                    {t("settings.mobileSettings.thisOlderDeviceNeedsReviewAndIs")}
                </p>
            )}
            <div className="remote-project-scope">
                <p className="remote-field-label">{t("settings.mobileConnect.projects")}</p>
                {projects.map((project) => (
                    <label className="remote-project-choice" key={project.id}>
                        <Input
                            unstyled
                            data-slot={undefined}
                            type="checkbox"
                            checked={selected.includes(project.id)}
                            onChange={(event) =>
                                setSelected((old) =>
                                    event.target.checked
                                        ? [...old, project.id]
                                        : old.filter((value) => value !== project.id),
                                )
                            }
                        />
                        {project.name ?? project.root.split("/").at(-1)}
                    </label>
                ))}
                {!projects.length && (
                    <p>{t("settings.mobileSettings.addAProjectInTheDesktopApp")}</p>
                )}
            </div>
            <fieldset
                className="remote-permissions"
                aria-label={t("settings.mobileSettings.permissionPreset")}
            >
                <legend className="remote-field-label">
                    {t("settings.mobileSettings.accessPermissions")}
                </legend>
                <div className="remote-permission-options">
                    {(
                        [
                            {
                                value: "Observer",
                                title: t("settings.mobileSettings.viewOnly"),
                                description: t("settings.mobileConnect.viewOnlyDescription"),
                            },
                            {
                                value: "Operator",
                                title: t("settings.mobileSettings.canOperate"),
                                description: t("settings.mobileConnect.canOperateDescription"),
                            },
                        ] satisfies { value: typeof preset; title: string; description: string }[]
                    ).map((option) => (
                        <label key={option.value} data-selected={preset === option.value}>
                            <Input
                                unstyled
                                data-slot={undefined}
                                type="radio"
                                name={`remote-preset-${id}`}
                                value={option.value}
                                checked={preset === option.value}
                                aria-label={option.title}
                                onChange={() => setPreset(option.value)}
                            />
                            <span>
                                <strong>{option.title}</strong>
                                <small>{option.description}</small>
                            </span>
                        </label>
                    ))}
                </div>
                <label className="remote-project-choice">
                    <Input
                        unstyled
                        data-slot={undefined}
                        type="checkbox"
                        checked={manage && preset === "Operator"}
                        disabled={preset !== "Operator"}
                        onChange={(event) => setManage(event.target.checked)}
                    />
                    <span>
                        <strong>{t("settings.mobileConnect.canManage")}</strong>
                        <small>{t("settings.mobileConnect.canManageDescription")}</small>
                    </span>
                </label>
            </fieldset>
            <div className="remote-grant-actions">
                {pending ? (
                    <Button
                        variant="destructive-subtle"
                        disabled={busy}
                        onClick={() => void run({ operation: "reject", id })}
                    >
                        {t("settings.mobileSettings.rejectPairing")}
                    </Button>
                ) : (
                    onCancel && (
                        <Button variant="ghost" disabled={busy} onClick={onCancel}>
                            {t("settings.mobileConnect.cancel")}
                        </Button>
                    )
                )}
                <Button
                    disabled={busy || !selected.length}
                    onClick={() =>
                        void run({
                            operation: pending ? "approve" : "updateGrant",
                            id,
                            projects: selected,
                            preset,
                            ...(preset === "Operator" && manage && { manage: true }),
                        })
                    }
                >
                    {pending
                        ? t("settings.mobileSettings.confirmPairing")
                        : t("settings.mobileSettings.saveAccess")}
                </Button>
            </div>
        </fieldset>
    );
}
