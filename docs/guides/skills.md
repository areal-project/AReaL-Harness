**中文** | [English](skills.en.md)

# Skill 发现与读取

CLI、TUI、serve 和直接 Core 共用发现规则；连接既有服务时使用服务端目录。自动发现和显式部署（包括 Profile 引用）都只登记元信息，正文与附件按需读取当前文件；发现阶段不缓存正文，成功加载的主体作为工具结果保留在会话历史中。

| 优先级 | 目录 |
|---|---|
| 1 | `<workspace>/.agents/skills/<name>/SKILL.md` |
| 2 | `<workspace>/.claude/skills/<name>/SKILL.md` |
| 3 | `<workspace>/.codex/skills/<name>/SKILL.md` |
| 4 | `~/.agents/skills/<name>/SKILL.md` |
| 5 | `~/.claude/skills/<name>/SKILL.md` |
| 6 | `~/.codex/skills/<name>/SKILL.md` |

同名按目录名精确覆盖整个 Skill，不合并资源、不用 frontmatter name 改身份。只发现直接子目录，不向父项目递归搜索；workspace 由可信启动参数决定，不随 RPC cwd 改变。主目录与 AREAL_HARNESS_HOME 分开。

## 启动时登记元信息

每个目录含 SKILL.md，可带 references/scripts/assets。发现阶段只解析 SKILL.md 的有界 YAML frontmatter，提取 name/description；没有 frontmatter 时使用目录名和首行描述。文件头最多 32 KiB，名称最多 256 字节，描述按 UTF-8 边界截取前 4096 字节；元信息限制不用于附件或正文。模型初始提示包含名称和有界描述，不注入完整正文。

不遍历、哈希或缓存附件，取消原来的单资源 256 KiB、目录总计 2 MiB 和附件数量限制。自动发现最多登记 512 个 Skill 名称。每个搜索目录最多包含 512 个原始目录项，普通文件、隐藏项和无效目录也占用此额度。自动发现的单个 Skill 元信息损坏、入口不合法或目录链接无效时，跳过该 Skill 并输出名称、路径与原因；不回退到同名低优先级副本。搜索根本身不可访问、越界或发现数量超限仍是启动错误。显式部署清单错误仍明确失败，避免静默缺失被指定的 Skill。

GUI 与 Core 的单次部署最多登记 512 个 Skill 版本引用。GUI 把当前启用引用和仍可读取的历史引用按 `id/revision` 去重后合计，历史版本也占用此额度。超限错误显示当前数量和上限，不截断或回收历史引用。部署文件仍限 1 MiB，单次部署最多 64 个 Profile，模型提示中的 Skill 描述总预算仍为 32 KiB。显式 `selectedSkills` 最多选择 128 项。容量调整不改变 Profile、工具、审批或文件读取权限。

Skill 根目录软链接可解析到授权的项目或全局 Skill 根；SKILL.md 入口不允许软链接。可信启动器也可直接注入已解析的元信息，见[桌面契约](../api/desktop.md#skills)。

## 完整加载主体与按需读取附件

`skill_list`、`skill_load` 与 `skill_resource_read` 默认无需人工或模型审批，“请求审批”和“帮我审批”均适用。显式 `permissions.deny`、`permissions.ask` 和 Profile／会话的强制审批规则仍优先；工具允许列表、当前 Turn 的 Skill 范围、插件撤权与资源路径检查保持不变。读取 Skill 不授予执行脚本、访问网络或读取任意宿主文件的权限。

`skill_list` 返回名称、描述与引用，不枚举附件；`resources` 为 null。模型选定 Skill 后，先调用 `skill_load {skill:{id,revision}}` 完整加载 `SKILL.md`，再应用其中的指令。按需加载决定选择哪些文件，不表示选中的主体只需读取第一页。相关附件使用 `skill_resource_read`；执行依赖的附属指令也应读完，查询资料可只读取相关范围。

`skill_load` 从一次打开的文件读取完整 UTF-8 主体，返回 `{id,revision,resource:"SKILL.md",text,sizeBytes,sha256,complete:true}`。包含 JSON 转义和元数据的完整响应最多 64 KiB；正文无效或超限明确失败，不返回成功的前缀。详细参考资料应移到独立文件，`SKILL.md` 保留适用条件、核心约束、执行顺序和资源导航。64 KiB 是该加载入口的资源上限，不是推荐长度，也不限制附件大小。

成功正文绕过通用工具的 16 KiB 头尾预览，原样计入工具输出及模型输入预算。首次求解请求消费前保护完整正文，不让自动摘要提前替代它；最终请求再次校验完整结果，放不下时明确停止，不扩充 Turn 或模型窗口预算。成功模型响应后沿用普通历史压缩；后续任务若仍需要已压缩的指令，应再次加载。完整交付不保证模型遵守规则，也不意味着正文在所有后续请求中永久保留。`skill_load` 不通过 `tool_program` 的选择性输出入口执行。

`skill_list.loaded` 保留兼容语义：记录成功访问过的 Skill 引用，包括分页和附件读取，不表示主体完整。新增 `loadedMain` 只列出当前历史投影中保留完整主体回执的 Skill，值为 `{revision,sha256,sourceItemId}`；它不是模型理解或遵守指令的确认，也不表示磁盘文件仍具有相同内容。压缩后不再保留完整回执时，该条目不再列出。

`skill_resource_read` 只读取被引用的附件，不接受 `SKILL.md` 或其路径别名；主体必须通过 `skill_load` 一次完整加载。每页最多 8192 字节；模型结果还受通用结果预算约束，转义开销较大的页面会自动缩短，使用 `offset/nextOffset/eof` 继续即可。`eof=true` 不证明之前的字节都读过。非末页有正文之外的 `notice` 和可原样传回的 `nextRead`，明确未读完及续读位置。有效 UTF-8 页只返回 `text`；页尾切开字符时，保留完整前缀并让下一页从该字符开始。二进制、非字符边界 offset 或小到放不下一个字符的显式页上限仍返回 `text:null` 与 `dataBase64`，不自动转换为图像或执行脚本。

模型分页结果附带 `resourceVersion`，`nextRead` 携带 `expectedVersion`。版本根据打开文件的身份、大小和纳秒修改时间生成；普通写入或替换后续读返回 `SKILL_RESOURCE_CHANGED`，应从 offset 0 重读，不能拼接旧页。它不是内容 hash，也不保证对抗性并发写入下的不可变快照；需要严格一致性的资源应使用只读版本目录或固定插件包。一次读取检测到长度或元数据变化也明确失败。

公共 `areal/skill/read` 与 Rust `read_skill` 保留原有字节分页契约：maxBytes 为 1–8192，返回 `dataBase64`、可解码的 `text`、`sizeBytes`、`nextOffset` 与 `eof`，不新增模型续读字段，不保证跨页版本一致。模型分页的 UTF-8 边界调整不改变公共 API 的 offset。

非插件 Skill 每次读取都从登记后的规范路径重新打开根目录，因此同路径目录或祖先目录替换后，旧引用读取当前文件。根路径逐段打开，拒绝更新后引入的根目录或祖先目录软链接。插件继续读取固定安装包并检查撤权。资源路径检查拒绝越界、内部文件/目录软链接和特殊文件；插件内相对引用仍限于安装包。坏附件仅使该次读取失败，不影响其他 Skill。元信息索引在重新登记或重启后更新。

兼容性：公共 `areal/skill/read`、Rust `read_skill` 与 `loaded` 字段继续可用；模型附件分页使用 `skill_resource_read`。显式工具允许列表需要加入 `skill_load` 和 `skill_resource_read` 才能使用新的模型入口，不自动扩大列表。回归验证完整交付、边界、权限与失败状态；模型续读率、规则遵守率及整体任务收益须独立评测。

## 引用与升级

自动发现的 revision 为 `metadata-<SHA-256>`，只标识解析后的元信息；显式部署使用清单指定的 revision。Skill 的 id/revision 是引用标识，不保证资源字节不变，同一引用允许读取更新后的文件。Profile/Turn/队列固定所选 Skill 引用，不冻结附件。Profile 和 Workflow 定义自身仍不可变。

默认根会话使用 `areal-discovered-skills` Profile，CLI 使用 `claude-cli` 并加载 CLAUDE.md；显式 Profile 只开放其 skills。旧 CLI `claude-<name>` ID 已改为目录名，历史引用保留。历史 Skill 引用未登记时明确不可用；需要恢复这些引用时，在显式部署清单登记其原 ID/revision 和目录，读取的仍是当前文件。

Web 和 TUI 可通过 `/skills` 打开当前会话的 Skill 选择器，也可用 `/skill NAME` 直接选择。选择会以 `selectedSkills` 写入会话配置，只影响后续 Turn；空配置仍沿用 Profile 的全部 Skill。

旧持久目录中的 skillHashes 会被忽略，后续保存不再写入内容摘要。旧清单 `{id,revision,root}` 继续有效，无需指定加载模式。配置与端到端验证见[桌面示例](../examples/desktop-api.md)。
