import { SettingsGroupCard, SettingsRow } from "@areal/ui/compositions";
import { useRef, useState } from "react";
import { ConversationComposer } from "../ConversationComposer.js";
import { SideChatPane } from "../SideChatPane.js";
import { SidePane } from "../app-shell/SidePane.js";
import { WorkbenchShell } from "../app-shell/WorkbenchShell.js";
import { Messages } from "../Messages.js";
import { Button } from "../components/ui/button.js";
import { SettingsDialog } from "../settings/common.js";
import { SettingsSelect } from "../settings/SettingsPageParts.js";
import type { Action, Data } from "../services.js";

// 只组合生产表面；不模拟受理或执行，真实提交由桌面专项验证。
export function SharedWorkspacePreview({ dark }: { dark: boolean }) {
  const [mode, setMode] = useState<"split" | "panel" | "conversation">("split");
  const [active, setActive] = useState("旁路讨论");
  const [tabs, setTabs] = useState(["旁路讨论", "文件"]);
  const [draft, setDraft] = useState("主会话未发送草稿");
  const [settings, setSettings] = useState(false);
  const [modelConfig, setModelConfig] = useState<Data>({
    model: { providerId: "preview", modelId: "shared" },
    parameters: { reasoningEffort: "low" },
  });
  const [value, setValue] = useState("normal");
  const trigger = useRef<HTMLButtonElement>(null);
  const project: Data = {
    id: "shared-design",
    root: "/preview",
    pending: [],
    core: { instanceId: "shared-design", connectionGeneration: 1, features: { sidePreview: true } },
    models: [
      {
        providerId: "preview",
        modelId: "shared",
        displayName: "用于检查窄面板的较长模型名称 Shared example model",
        reasoningEffortOptions: ["low", "high"],
      },
      {
        providerId: "preview-alternate",
        modelId: "shared",
        displayName: "用于检查窄面板的较长模型名称 Shared example model",
        reasoningEffortOptions: ["low", "high"],
      },
    ],
    configurations: {
      shared: {
        model: { providerId: "preview", modelId: "shared" },
        parameters: { reasoningEffort: "low" },
      },
    },
    state: { connected: true, threads: {}, interactions: {}, queues: {} },
  };
  const thread = {
    id: "shared",
    preview: "共享交互验证",
    updatedAt: 1,
    turns: [
      {
        id: "shared-turn",
        status: "completed",
        items: [
          {
            id: "shared-final",
            type: "agentMessage",
            phase: "final_answer",
            text: "主会话保留原位。打开侧边聊天、文件或设置后继续输入。",
          },
        ],
      },
    ],
  };
  const action = (async () => {
    throw Error("此预览不连接 Core，也不执行提交。");
  }) as Action;
  const close = () => {
    setActive("");
    setMode("split");
    requestAnimationFrame(() => trigger.current?.focus());
  };
  return (
    <section className="design-preview-panel" aria-label="共享工作区预览">
      <h2>主会话、Side 与面板</h2>
      <div className="design-preview-actions">
        <Button
          ref={trigger}
          onClick={() => {
            setActive("旁路讨论");
            setTabs((t) => (t.includes("旁路讨论") ? t : [...t, "旁路讨论"]));
            setMode("split");
          }}
        >
          打开侧边聊天
        </Button>
        <Button onClick={() => setSettings(true)}>打开共享设置</Button>
      </div>
      <WorkbenchShell className="design-shared-workspace">
        <div
          className="work-area"
          data-workspace-view={mode === "split" ? undefined : mode}
          data-shared-mode={mode}
        >
          <div className="work-surface">
            <div className="workspace-content">
              <div className="conversation-column">
                <div className="conversation-pane">
                  <Messages
                    project={project}
                    thread={thread}
                    action={action}
                    dark={dark}
                    onLink={() => {}}
                    onFile={() => {}}
                    onReview={() => {}}
                    readTurnReview={async () => ({})}
                  />
                  <div className="active-composer">
                    <div className="composer-dock">
                      <ConversationComposer
                        project={project}
                        modelConfig={modelConfig}
                        onConfigureModel={(next) =>
                          setModelConfig((current) => ({ ...current, ...next }))
                        }
                        surfaceLayout={mode === "panel" ? "compact" : "default"}
                        workspacePath="/preview"
                        taskId="shared"
                        initialValue={draft}
                        onChange={setDraft}
                        inputTestId="shared-main-input"
                        submitLabel="发送"
                        enterSubmits
                        enableMentionPanel={false}
                        onSubmit={() => false}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <SidePane
            workspaceKey="shared-design"
            ownerTaskId="shared"
            active={active}
            names={tabs}
            onSelect={(id) => {
              setActive(id);
              if (mode === "conversation") setMode("panel");
            }}
            onChange={setTabs}
            onHide={close}
            dirtyFiles={{}}
            canClose={() => true}
            workspaceView={{ mode, title: "共享交互验证", onChange: setMode }}
            render={(name) =>
              name === "旁路讨论" ? (
                <SideChatPane
                  project={project}
                  source={thread}
                  action={action}
                  dark={dark}
                  executionBlocked={false}
                  onReturn={close}
                  onPanel={() => setSettings(true)}
                />
              ) : (
                <div className="p-4" role="region" aria-label="共享文件阅读">
                  <p>文件面板保持独立阅读。</p>
                  <pre>export const shared = true;</pre>
                </div>
              )
            }
          />
        </div>
      </WorkbenchShell>
      {settings && (
        <SettingsDialog
          title="共享设置验证"
          description="共享设置组件，本地展示。"
          onClose={() => setSettings(false)}
        >
          <SettingsGroupCard>
            <SettingsRow
              label="阅读密度"
              control={
                <SettingsSelect aria-label="共享阅读密度" value={value} onValueChange={setValue}>
                  <option value="normal">常规</option>
                  <option value="relaxed">宽松</option>
                  <option value="compact">紧凑</option>
                </SettingsSelect>
              }
            />
          </SettingsGroupCard>
        </SettingsDialog>
      )}
    </section>
  );
}
