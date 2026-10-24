// 由 design-system/registry.json 生成；运行 pnpm --dir clients/gui design:sync。
// 只记录角色与定义名，数值始终从生产 CSS 读取。
export const tokenGroups = [
  {
    "title": "文字",
    "tokens": [
      [
        "--text-ui-lg",
        "输入与强调正文"
      ],
      [
        "--text-ui-base",
        "正文"
      ],
      [
        "--text-ui-caption",
        "控件标签"
      ],
      [
        "--text-content-caption",
        "过程与结果附注"
      ],
      [
        "--text-ui-sm",
        "说明"
      ],
      [
        "--text-ui-xs",
        "辅助信息"
      ],
      [
        "--line-height-ui",
        "公共内容行高"
      ],
      [
        "--line-height-ui-sm",
        "紧凑说明行高"
      ]
    ]
  },
  {
    "title": "表面与反馈",
    "tokens": [
      [
        "--color-background",
        "页面背景"
      ],
      [
        "--color-composer",
        "输入表面"
      ],
      [
        "--color-primary",
        "主要动作背景"
      ],
      [
        "--color-primary-foreground",
        "主要动作文字"
      ],
      [
        "--color-foreground",
        "主要文字"
      ],
      [
        "--color-foreground-subtle",
        "次要文字"
      ],
      [
        "--color-border",
        "分隔与边框"
      ],
      [
        "--color-button-surface",
        "次要按钮"
      ],
      [
        "--color-button-hover",
        "按钮悬停"
      ],
      [
        "--color-destructive",
        "错误反馈"
      ]
    ]
  },
  {
    "title": "尺寸与间距",
    "tokens": [
      [
        "--spacing-control",
        "标准控件"
      ],
      [
        "--spacing-control-sm",
        "紧凑控件"
      ],
      [
        "--spacing-inline",
        "相邻内容"
      ],
      [
        "--spacing-field",
        "内容块"
      ],
      [
        "--spacing-section",
        "分区"
      ],
      [
        "--reading-width",
        "对话与输入阅读列"
      ]
    ]
  },
  {
    "title": "形状与动效",
    "tokens": [
      [
        "--radius-control",
        "控件"
      ],
      [
        "--radius-button",
        "操作按钮与下拉触发器"
      ],
      [
        "--radius-overlay",
        "浮层和决策卡片"
      ],
      [
        "--radius-composer",
        "输入区"
      ],
      [
        "--motion-fast",
        "控件反馈"
      ],
      [
        "--focus-width",
        "焦点描边"
      ],
      [
        "--radius-inset",
        "表面内的预览内容"
      ],
      [
        "--radius-pill",
        "胶囊或圆形动作"
      ]
    ]
  }
] as const;
export const baseCandidate = {
  "id": "desktop-core",
  "version": "0.4.0",
  "foundations": [
    "文字",
    "表面与反馈",
    "尺寸与间距",
    "形状与动效"
  ],
  "primitives": [
    "Button",
    "ActionButton",
    "Switch",
    "Select",
    "Feedback"
  ],
  "compositions": [
    "SettingsPage",
    "SettingsSection",
    "SettingsGroupCard",
    "SettingsRow",
    "SettingsSelect",
    "SettingsSegmentedTabs",
    "SettingsDisclosure",
    "DecisionCard",
    "ApprovalRequest",
    "CollapsibleText",
    "Messages",
    "TurnProgress",
    "TurnExecution",
    "ToolEvent",
    "SettingsSearchInput"
  ],
  "patterns": [
    "P-SETTINGS",
    "P-DECISION",
    "P-RESOURCES"
  ],
  "acceptance": [
    "角色引用现有生产来源；目录不存数值副本",
    "按成员准入表检查有限变体与状态；证据索引区分复验命令和已完成运行",
    "设置组合挂载真实 SettingsPage 上下文；不只展示脱离页面的库默认",
    "明暗、14/18 字号、宽/窄与键盘交互有独立运行断言",
    "决策与长文本保留原权威状态、全文和焦点可达性",
    "设置单选沿SettingsSelect公共sm变体；普通设置开关使用default，不由调用方另改尺寸",
    "活跃设置说明保留独立角色、对比度偏好与自定义前景色，不连带修改禁用或过程信息",
    "对话过程组合在逐步投影中验证接受消息占位、可见阅读锚点、返回最新、完成收敛及人工详情保留；异常不因final默认隐藏",
    "插件资源目录的加载、搜索、空态、局部失败、项目启停、原提交核对与返回有真实 GUI 证据",
    "同主窗口 Renderer 重载与崩溃后显式重载保留已加载阅读段落、偏移与草稿；原执行继续且不重放，显式返回最新后保持跟随"
  ],
  "limits": [
    "frozen-beta 仅表示列明 GUI 切片可作为固定输入，不代表稳定公共 API 或全 GUI 验收",
    "Base 仅准入列明 renderer 组件；真实 GUI 路径沿既有 Core 验证，Core API、真实供应商、安装包、Web、CLI/TUI和完整自定义主题矩阵在范围外",
    "成员状态与变体是有限准入声明，不表示每项笛卡尔组合均已运行；已完成证据以索引记录为准",
    "完整P-CONVERSATION、SidePane、原生资源宿主、列明同窗口Renderer恢复以外的恢复生命周期和完整插件安装/认证/连接生命周期未准入；P-RESOURCES仅限列明插件路径"
  ],
  "status": "frozen-beta",
  "snapshot": {
    "revision": "68530d8703a19baf023ff64b1026925545fb3151",
    "owner": "design-system/base.md"
  },
  "admissions": [
    {
      "id": "Button",
      "contract": "packages/ui/src/components/button/button.md",
      "consumers": [
        "renderer/src/ApprovalRequest.tsx",
        "renderer/src/settings/PluginCenter.tsx"
      ],
      "variants": [
        "default/default",
        "secondary/sm",
        "outline/default",
        "ghost/sm"
      ],
      "states": [
        "default",
        "disabled",
        "keyboard-focus"
      ],
      "evidence": [
        "E-CONTROLS",
        "E-PLUGINS"
      ]
    },
    {
      "id": "ActionButton",
      "contract": "renderer/src/components/ui/action-button.md",
      "consumers": [
        "renderer/src/settings/DisplaySettings.tsx"
      ],
      "variants": [
        "secondary/sm"
      ],
      "states": [
        "default",
        "disabled",
        "pending"
      ],
      "evidence": [
        "E-CONTROLS"
      ]
    },
    {
      "id": "Switch",
      "contract": "renderer/src/components/ui/switch.md",
      "consumers": [
        "renderer/src/settings/SettingsPageParts.tsx",
        "renderer/src/settings/PluginCenter.tsx"
      ],
      "variants": [
        "default"
      ],
      "states": [
        "checked",
        "unchecked",
        "disabled",
        "keyboard-focus"
      ],
      "evidence": [
        "E-CONTROLS",
        "E-PLUGINS"
      ]
    },
    {
      "id": "Select",
      "contract": "renderer/src/components/ui/select.md",
      "consumers": [
        "renderer/src/settings/SettingsPageParts.tsx"
      ],
      "variants": [
        "secondary/sm"
      ],
      "states": [
        "closed",
        "open",
        "selected",
        "disabled",
        "keyboard-focus"
      ],
      "evidence": [
        "E-CONTROLS"
      ],
      "exports": [
        "Select",
        "SelectTrigger",
        "SelectValue",
        "SelectContent",
        "SelectItem"
      ]
    },
    {
      "id": "Feedback",
      "contract": "renderer/src/components/ui/feedback.md",
      "consumers": [
        "renderer/src/DecisionCard.tsx",
        "renderer/src/settings/PluginCenter.tsx"
      ],
      "variants": [
        "inline"
      ],
      "states": [
        "empty",
        "status",
        "error",
        "unknown-message"
      ],
      "evidence": [
        "E-CONTROLS",
        "E-PLUGINS"
      ]
    },
    {
      "id": "SettingsPage",
      "contract": "renderer/src/settings/SettingsPageParts.md#settingspage",
      "consumers": [
        "renderer/src/App.tsx"
      ],
      "variants": [
        "settings-workspace"
      ],
      "states": [
        "titled",
        "untitled",
        "wide",
        "narrow"
      ],
      "evidence": [
        "E-SETTINGS"
      ]
    },
    {
      "id": "SettingsSection",
      "contract": "renderer/src/settings/SettingsPageParts.md#settingssection",
      "consumers": [
        "renderer/src/settings/DisplaySettings.tsx"
      ],
      "variants": [
        "heading",
        "body-only"
      ],
      "states": [
        "default"
      ],
      "evidence": [
        "E-SETTINGS"
      ]
    },
    {
      "id": "SettingsGroupCard",
      "contract": "renderer/src/settings/SettingsPageParts.md#settingsgroupcard",
      "consumers": [
        "renderer/src/settings/DisplaySettings.tsx"
      ],
      "variants": [
        "default",
        "compact"
      ],
      "states": [
        "default"
      ],
      "evidence": [
        "E-SETTINGS"
      ]
    },
    {
      "id": "SettingsRow",
      "contract": "renderer/src/settings/SettingsPageParts.md#settingsrow",
      "consumers": [
        "renderer/src/settings/DisplaySettings.tsx"
      ],
      "variants": [
        "default",
        "wide"
      ],
      "states": [
        "default",
        "disabled",
        "with-detail"
      ],
      "evidence": [
        "E-SETTINGS"
      ]
    },
    {
      "id": "SettingsSelect",
      "contract": "renderer/src/settings/SettingsPageParts.md#settingsselect",
      "consumers": [
        "renderer/src/settings/DisplaySettings.tsx"
      ],
      "variants": [
        "two-value-segmented",
        "multi-value-secondary-sm"
      ],
      "states": [
        "selected",
        "disabled"
      ],
      "evidence": [
        "E-SETTINGS"
      ]
    },
    {
      "id": "SettingsSegmentedTabs",
      "contract": "renderer/src/settings/SettingsPageParts.md#settingssegmentedtabs",
      "consumers": [
        "renderer/src/settings/DisplaySettings.tsx",
        "renderer/src/settings/PluginCenter.tsx"
      ],
      "variants": [
        "automatic-activation",
        "manual-activation"
      ],
      "states": [
        "selected",
        "disabled",
        "keyboard-focus"
      ],
      "evidence": [
        "E-SETTINGS",
        "E-PLUGINS"
      ]
    },
    {
      "id": "SettingsDisclosure",
      "contract": "renderer/src/settings/SettingsPageParts.md#settingsdisclosure",
      "consumers": [
        "renderer/src/settings/DisplaySettings.tsx",
        "renderer/src/settings/PluginCenter.tsx"
      ],
      "variants": [
        "native-details"
      ],
      "states": [
        "collapsed",
        "expanded",
        "keyboard-focus"
      ],
      "evidence": [
        "E-SETTINGS",
        "E-PLUGINS"
      ]
    },
    {
      "id": "DecisionCard",
      "contract": "renderer/src/DecisionCard.md#decisioncard",
      "consumers": [
        "renderer/src/ApprovalRequest.tsx"
      ],
      "variants": [
        "approval",
        "question"
      ],
      "states": [
        "ready",
        "busy",
        "failed",
        "unknown-message"
      ],
      "evidence": [
        "E-DECISION"
      ]
    },
    {
      "id": "ApprovalRequest",
      "contract": "renderer/src/DecisionCard.md#approvalrequest",
      "consumers": [
        "renderer/src/TaskRunConversations.tsx"
      ],
      "variants": [
        "once-only",
        "remember-allowed"
      ],
      "states": [
        "ready",
        "busy",
        "submitted",
        "failed",
        "unknown"
      ],
      "evidence": [
        "E-DECISION"
      ]
    },
    {
      "id": "CollapsibleText",
      "contract": "renderer/src/CollapsibleText.md",
      "consumers": [
        "renderer/src/Messages.tsx"
      ],
      "variants": [
        "measured-preview"
      ],
      "states": [
        "short",
        "collapsed",
        "expanded",
        "keyboard-focus"
      ],
      "evidence": [
        "E-DECISION"
      ]
    },
    {
      "id": "Messages",
      "contract": "renderer/src/Messages.md#messages",
      "consumers": [
        "renderer/src/App.tsx"
      ],
      "variants": [
        "main",
        "embedded"
      ],
      "states": [
        "accepted-placeholder",
        "following-latest",
        "reading-history",
        "completed",
        "failed",
        "unknown",
        "renderer-recovered-reading"
      ],
      "evidence": [
        "E-CONVERSATION",
        "E-RECOVERY"
      ]
    },
    {
      "id": "TurnProgress",
      "contract": "renderer/src/Messages.md#turnprogress",
      "consumers": [
        "renderer/src/Messages.tsx"
      ],
      "variants": [
        "ordered-progress"
      ],
      "states": [
        "working",
        "settled",
        "manual-expanded",
        "failed",
        "unfinished"
      ],
      "evidence": [
        "E-CONVERSATION"
      ]
    },
    {
      "id": "TurnExecution",
      "contract": "renderer/src/Messages.md#turnexecution",
      "consumers": [
        "renderer/src/Messages.tsx"
      ],
      "variants": [
        "direct-item",
        "grouped-items"
      ],
      "states": [
        "working",
        "completed-summary",
        "failed",
        "unknown",
        "manual-expanded"
      ],
      "evidence": [
        "E-CONVERSATION"
      ]
    },
    {
      "id": "ToolEvent",
      "contract": "renderer/src/Messages.md#toolevent",
      "consumers": [
        "renderer/src/Messages.tsx"
      ],
      "variants": [
        "tool-summary",
        "raw-record"
      ],
      "states": [
        "running",
        "completed",
        "failed",
        "unknown",
        "expanded"
      ],
      "evidence": [
        "E-CONVERSATION"
      ]
    },
    {
      "id": "SettingsSearchInput",
      "contract": "renderer/src/settings/SettingsSearchInput.md",
      "consumers": [
        "renderer/src/settings/PluginCenter.tsx"
      ],
      "variants": [
        "search-lg"
      ],
      "states": [
        "empty",
        "query",
        "clear",
        "keyboard-focus"
      ],
      "evidence": [
        "E-PLUGINS"
      ]
    }
  ],
  "evidence": [
    {
      "id": "E-CONTROLS",
      "checker": "scripts/design-system-smoke.mjs",
      "report": "design-system/base-evidence.md#e-controls"
    },
    {
      "id": "E-SETTINGS",
      "checker": "scripts/design-system-smoke.mjs",
      "report": "design-system/base-evidence.md#e-settings"
    },
    {
      "id": "E-DECISION",
      "checker": "scripts/design-system-smoke.mjs",
      "report": "design-system/base-evidence.md#e-decision"
    },
    {
      "id": "E-CONVERSATION",
      "checker": "scripts/design-system-conversation-exercise.mjs",
      "report": "design-system/base-evidence.md#e-conversation"
    },
    {
      "id": "E-RESOURCES",
      "checker": "scripts/resource-smoke.mjs",
      "report": "design-system/base-evidence.md#e-resources"
    },
    {
      "id": "E-PLUGINS",
      "checker": "scripts/plugin-resource-smoke.mjs",
      "report": "design-system/base-evidence.md#e-plugins"
    },
    {
      "id": "E-RECOVERY",
      "checker": "scripts/service-reopen-smoke.mjs",
      "report": "design-system/base-evidence.md#e-recovery"
    }
  ]
} as const;
