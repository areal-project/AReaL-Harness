import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { useState } from "react";
import { ActionButton } from "../components/ui/action-button.js";
import { Feedback } from "../components/ui/feedback.js";
import { SettingsDialog } from "../settings/common.js";
import { GeneralSettings } from "../settings/DisplaySettings.js";
import { SettingsPage } from "../settings/SettingsWorkspace.js";
import {
  SettingsLockedValue,
  SettingsSelect,
  SettingsSwitch,
} from "../settings/SettingsPageParts.js";
import "../settings/MobileSettings.css";

const presentations = {
  ready: "可操作",
  disabled: "不可用",
  pending: "处理中",
  failed: "明确失败",
  unknown: "结果待确认",
} as const;
type Presentation = keyof typeof presentations;

function SettingsSample({ name }: { name: string }) {
  const [enabled, setEnabled] = useState(true);
  const [text, setText] = useState("保留当前内容 Current value");
  const [number, setNumber] = useState(3);
  const [range, setRange] = useState(14);
  const [choice, setChoice] = useState("system");
  return (
    <SettingsSection
      title="共享设置 Shared settings"
      description="说明在页面、弹窗和独立预览中保持一致。 Description keeps its own typography."
    >
      <SettingsGroupCard>
        <SettingsRow
          label="显示辅助面板"
          description="本地值只属于当前预览。"
          control={
            <SettingsSwitch
              aria-label={`${name}开关`}
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          }
        />
        <SettingsRow
          label="很长的中文与 English 设置名称用于确认换行后内容仍然完整可读"
          description="Long descriptions wrap inside the shared settings row without hiding the current control value."
          controlLayout="wide"
          detail={<SettingsLockedValue label={`${name}已确认值`} value="已确认 Confirmed" />}
          control={
            <input
              aria-label={`${name}文本`}
              type="text"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          }
        />
        <SettingsRow
          label="重试次数"
          control={
            <input
              aria-label={`${name}数字`}
              type="number"
              min={1}
              max={9}
              value={number}
              onChange={(event) => setNumber(Number(event.target.value))}
            />
          }
        />
        <SettingsRow
          label="预览字号"
          control={
            <>
              <input
                aria-label={`${name}范围`}
                type="range"
                min={12}
                max={20}
                value={range}
                onChange={(event) => setRange(Number(event.target.value))}
              />
              <output aria-label={`${name}范围值`}>{range}</output>
            </>
          }
        />
        <SettingsRow
          label="显示模式"
          control={
            <SettingsSelect aria-label={`${name}显示模式`} value={choice} onValueChange={setChoice}>
              <option value="system">跟随系统</option>
              <option value="light">明亮</option>
              <option value="dark">深色</option>
            </SettingsSelect>
          }
        />
      </SettingsGroupCard>
    </SettingsSection>
  );
}

export function SettingsPreview() {
  const [dialog, setDialog] = useState(false);
  const [generalKey, setGeneralKey] = useState(0);
  const [presentation, setPresentation] = useState<Presentation>("ready");
  const [draft, setDraft] = useState("待保存草稿 Draft stays here");
  const [feedback, setFeedback] = useState("");
  const blocked = presentation !== "ready" && presentation !== "failed";
  return (
    <section className="design-preview-panel design-settings-preview" aria-label="设置组合预览">
      <h2>设置组合与真实宿主</h2>
      <p>共享展示使用生产组件。常规设置只验证浏览器偏好，服务操作不可用。</p>
      <div className="design-preview-actions">
        <ActionButton onClick={() => setDialog(true)}>打开设置弹窗</ActionButton>
        <ActionButton onClick={() => setGeneralKey((value) => value + 1)}>
          重新挂载常规设置
        </ActionButton>
      </div>
      <div data-settings-host="standalone">
        <SettingsSample name="独立" />
      </div>
      <div data-settings-host="page">
        <SettingsPage title="页面设置" subtitle="生产 SettingsPage">
          <SettingsSample name="页面" />
        </SettingsPage>
      </div>
      <div data-settings-host="compact">
        <SettingsSection title="紧凑设置" description="保留当前紧凑行与分隔线。">
          <SettingsGroupCard density="compact">
            <SettingsRow
              label="主题"
              control={<SettingsLockedValue label="紧凑主题" value="跟随系统" />}
            />
            <SettingsRow
              label="状态"
              control={<SettingsLockedValue label="紧凑状态" value="已连接" />}
            />
          </SettingsGroupCard>
        </SettingsSection>
      </div>
      <div data-settings-host="mobile">
        <SettingsGroupCard layout="grid" className="remote-access-panel">
          <div className="remote-access-fields">
            Mobile 的直接 card-content 插槽与 layout="grid" 间距。
          </div>
        </SettingsGroupCard>
      </div>
      <div data-settings-host="general">
        <SettingsPage title="常规设置">
          <GeneralSettings key={generalKey} />
        </SettingsPage>
      </div>
      <div data-settings-host="states">
        <SettingsSection
          title="外部状态展示"
          description="仅展示调用方提供的状态，不代表常规设置支持未知提交，也不执行保存。"
        >
          <label className="design-settings-state">
            展示状态
            <select
              aria-label="设置展示状态"
              value={presentation}
              onChange={(event) => {
                setPresentation(event.target.value as Presentation);
                setFeedback("");
              }}
            >
              {Object.entries(presentations).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <SettingsGroupCard>
            <SettingsRow
              label="当前草稿"
              disabled={blocked}
              description="状态变化保留当前值。"
              control={
                <input
                  type="text"
                  aria-label="状态草稿"
                  value={draft}
                  disabled={blocked}
                  onChange={(event) => setDraft(event.target.value)}
                />
              }
            />
            <SettingsRow
              label="保存入口"
              disabled={blocked}
              control={
                <ActionButton
                  disabled={blocked}
                  pending={presentation === "pending"}
                  onClick={() =>
                    setFeedback(
                      presentation === "failed"
                        ? "示例操作明确失败，草稿已保留。"
                        : "本地展示不执行保存。",
                    )
                  }
                >
                  保存
                </ActionButton>
              }
            />
          </SettingsGroupCard>
          <Feedback
            error={
              presentation === "failed" ? feedback || "示例操作明确失败，草稿已保留。" : undefined
            }
            message={
              presentation === "unknown"
                ? "结果待确认，保留当前值；不重复提交。"
                : presentation === "pending"
                  ? "正在处理，等待原操作结果。"
                  : presentation === "disabled"
                    ? "当前操作不可用。"
                    : feedback
            }
          />
        </SettingsSection>
      </div>
      {dialog && (
        <SettingsDialog
          title="设置弹窗预览"
          description="生产 portal SettingsDialog，本地展示。"
          onClose={() => setDialog(false)}
        >
          <div data-settings-host="dialog">
            <SettingsSample name="弹窗" />
          </div>
        </SettingsDialog>
      )}
    </section>
  );
}
