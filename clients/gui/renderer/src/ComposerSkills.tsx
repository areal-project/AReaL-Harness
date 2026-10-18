import { useEffect, useState } from "react";
import { Box } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import { CloseIcon } from "./interfaceIcons.js";
import type { Action, Data } from "./services.js";
import type { ComposerCatalogData, ComposerCatalogEntry } from "./prompt-editor/ComposerCatalog.js";

export interface ComposerSkill {
    id: string;
    revision: string;
    name: string;
    description: string;
    source: string;
}
const identity = (skill: ComposerSkill) => `${skill.id}/${skill.revision}`;
export function readComposerSkills(key: string): ComposerSkill[] {
    const value: unknown = JSON.parse(localStorage.getItem(`${key}:skills`) ?? "[]");
    if (
        !Array.isArray(value) ||
        value.some(
            (item) =>
                typeof item?.id !== "string" ||
                typeof item?.revision !== "string" ||
                typeof item?.name !== "string",
        )
    )
        throw new Error("技能草稿无法读取，请移除后重新附加。");
    return value;
}
export const clearComposerSkills = (key: string) => localStorage.removeItem(`${key}:skills`);
export function transferComposerSkills(from: string, to: string) {
    const value = localStorage.getItem(`${from}:skills`);
    if (value) localStorage.setItem(`${to}:skills`, value);
}
export function useComposerSkills({
    project,
    threadId,
    profile,
    draftKey,
    action,
    disabled,
}: {
    project: Data;
    threadId?: string;
    profile?: Data;
    draftKey: string;
    action: Action;
    disabled?: boolean;
}) {
    const [selected, setSelected] = useState<ComposerSkill[]>([]);
    const [catalog, setCatalog] = useState<ComposerSkill[]>([]);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        const read = () => {
            try {
                setSelected(readComposerSkills(draftKey));
            } catch (cause) {
                setError((cause as Error).message);
            }
        };
        const refresh = (event: Event) => {
            if ((event as CustomEvent<string>).detail === draftKey) read();
        };
        read();
        window.addEventListener("areal-draft-change", refresh);
        return () => window.removeEventListener("areal-draft-change", refresh);
    }, [draftKey]);
    useEffect(() => {
        let active = true;
        setCatalog([]);
        if (!project.state?.connected || (!threadId && !profile)) return;
        setLoading(true);
        void action("manage", {
            projectId: project.id,
            operation: "skills",
            ...(threadId
                ? { threadId }
                : { agentProfile: { id: profile!.id, revision: profile!.revision } }),
        })
            .then(async (result) => {
                // 来源只是展示信息；可选技能始终来自 Core 的当前 Profile/Thread。
                const sources = await Promise.allSettled(
                    ["project", "user"].map((scope) =>
                        action("resources", { operation: "skills", scope, projectId: project.id }),
                    ),
                );
                if (!active) return;
                setCatalog(
                    (result.data ?? [])
                        .filter((row: Data) => row.available)
                        .map((row: Data) => {
                            const scope = sources.findIndex(
                                (value) =>
                                    value.status === "fulfilled" &&
                                    value.value.data?.some(
                                        (item: Data) =>
                                            item.id === row.id && item.revision === row.revision,
                                    ),
                            );
                            return {
                                id: row.id,
                                revision: row.revision,
                                name: row.name ?? row.id,
                                description: row.description ?? "",
                                source:
                                    scope === 0
                                        ? (project.name ?? "当前项目")
                                        : scope === 1
                                          ? "个人"
                                          : `任务配置 · ${row.id}`,
                            };
                        }),
                );
                setError("");
            })
            .catch((cause) => {
                if (active) setError(`无法读取 Skills：${cause.message}`);
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, [
        project.id,
        project.state?.connected,
        threadId,
        profile?.id,
        profile?.revision,
        project.configurations?.[threadId ?? ""]?.revision,
        revision,
    ]);
    const update = (next: ComposerSkill[]) => {
        localStorage.setItem(`${draftKey}:skills`, JSON.stringify(next));
        setSelected(next);
    };
    const entries: ComposerCatalogEntry[] = catalog.map((skill) => ({
        value: `skill:${identity(skill)}`,
        label: skill.name,
        description: skill.description,
        source: skill.source,
        group: "Skills",
        icon: <Box size={16} />,
        attached: selected.some((item) => identity(item) === identity(skill)),
        run: () => {
            if (!selected.some((item) => identity(item) === identity(skill)))
                update([...selected, skill]);
        },
    }));
    return {
        selected,
        error,
        catalog: {
            entries,
            loading,
            error,
            refresh: () => setRevision((value) => value + 1),
        } satisfies ComposerCatalogData,
        clear: () => {
            clearComposerSkills(draftKey);
            setSelected([]);
        },
        tags: (
            <div className="composer-skill-tags">
                {selected.map((skill) => (
                    <ComposerSkillTag
                        key={identity(skill)}
                        skill={skill}
                        duplicate={selected.filter((item) => item.name === skill.name).length > 1}
                        disabled={disabled}
                        onRemove={() =>
                            update(selected.filter((item) => identity(item) !== identity(skill)))
                        }
                        read={() =>
                            composerSkillContent(action, project.id, threadId, [skill], profile)
                        }
                    />
                ))}
            </div>
        ),
    };
}

/** 提交前按 Core 的有界读取协议读取正文；任何失败均阻止发送，标签留在原草稿。 */
export async function composerSkillContent(
    action: Action,
    projectId: string,
    threadId: string | undefined,
    skills: ComposerSkill[],
    profile?: Data,
) {
    const blocks: string[] = [];
    for (const skill of skills) {
        try {
            const bytes: Uint8Array[] = [];
            let offset = 0;
            for (;;) {
                const page = await action("manage", {
                    projectId,
                    ...(threadId
                        ? { threadId }
                        : { agentProfile: { id: profile?.id, revision: profile?.revision } }),
                    operation: "skill",
                    skill: { id: skill.id, revision: skill.revision },
                    resource: "SKILL.md",
                    offset,
                    maxBytes: 8192,
                });
                if (page.sizeBytes > 256 * 1024)
                    throw new Error("技能正文超过消息附件上限 256 KiB");
                bytes.push(Uint8Array.from(atob(page.dataBase64), (char) => char.charCodeAt(0)));
                if (page.eof) break;
                if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)
                    throw new Error("技能分页无效");
                offset = page.nextOffset;
            }
            const merged = new Uint8Array(bytes.reduce((sum, chunk) => sum + chunk.length, 0));
            let position = 0;
            for (const chunk of bytes) {
                merged.set(chunk, position);
                position += chunk.length;
            }
            blocks.push(
                `<skill name=${JSON.stringify(skill.name)} source=${JSON.stringify(skill.source)} id=${JSON.stringify(skill.id)} revision=${JSON.stringify(skill.revision)}>\n${new TextDecoder("utf-8", { fatal: true }).decode(merged)}\n</skill>`,
            );
        } catch (cause) {
            throw new Error(
                `无法读取技能 ${skill.name}：${(cause as Error).message}。草稿已保留。`,
            );
        }
    }
    return blocks.join("\n\n");
}

function ComposerSkillTag({
    skill,
    duplicate,
    disabled,
    onRemove,
    read,
}: {
    skill: ComposerSkill;
    duplicate: boolean;
    disabled?: boolean;
    onRemove: () => void;
    read: () => Promise<string>;
}) {
    const [content, setContent] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    return (
        <span className="composer-skill-tag">
            <Popover
                onOpenChange={(open) => {
                    if (!open) return;
                    setContent(null);
                    setError("");
                    setLoading(true);
                    void read()
                        .then(setContent)
                        .catch((cause) => setError(cause.message))
                        .finally(() => setLoading(false));
                }}
            >
                <PopoverTrigger
                    className="composer-skill-preview-trigger"
                    disabled={disabled}
                    aria-label={`查看技能 ${skill.name} ${skill.source}`}
                >
                    <Box size={14} />
                    {skill.name}
                    {duplicate && <small>{skill.source}</small>}
                </PopoverTrigger>
                <PopoverContent
                    side="top"
                    className="composer-skill-preview"
                    aria-label={`技能 ${skill.name}`}
                >
                    <strong>{skill.name}</strong>
                    <small>{skill.source}</small>
                    <p>{skill.description}</p>
                    {loading ? (
                        <p>正在读取内容…</p>
                    ) : error ? (
                        <p role="alert">{error}</p>
                    ) : (
                        <pre>{content}</pre>
                    )}
                </PopoverContent>
            </Popover>
            <button
                type="button"
                disabled={disabled}
                aria-label={`移除技能 ${skill.name} ${skill.source}`}
                onClick={onRemove}
            >
                <CloseIcon size={12} />
            </button>
        </span>
    );
}
